'use strict';
const $ = (id) => document.getElementById(id);
const apiBase = '/v1/admin/facebook-messenger';
let token = sessionStorage.getItem('facebook_saas_jwt') || '';
let setup,
  activeId,
  messageCursor,
  conversationCursor,
  polling = false,
  sending = false,
  generation = 0;
let pages = [],
  conversations = new Map(),
  messages = new Map(),
  attempt;

function notice(text, type = 'error') {
  $('notice').textContent = text;
  $('notice').className = type;
  $('notice').hidden = !text;
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(apiBase + path, {
      ...options,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new Error(
      'The request could not be confirmed. Check your connection. Replies are not automatically sent again.',
    );
  }
  const data = await response.json();
  if (!response.ok || !data.success) {
    if (response.status === 401) logOut();
    throw new Error(data.message || 'Request failed.');
  }
  return data.data;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.onclick = async () => {
    node.disabled = true;
    try {
      await action();
    } catch (e) {
      notice(e.message);
    } finally {
      node.disabled = false;
    }
  };
  return node;
}
function showTab(tab) {
  $('integrations').hidden = tab !== 'integrations';
  $('inbox').hidden = tab !== 'inbox';
  $('integration-tab').classList.toggle('active', tab === 'integrations');
  $('inbox-tab').classList.toggle('active', tab === 'inbox');
}
function logOut() {
  token = '';
  generation++;
  sessionStorage.removeItem('facebook_saas_jwt');
  sessionStorage.removeItem('facebook_saas_name');
  setup = null;
  activeId = null;
  attempt = null;
  pages = [];
  conversations.clear();
  messages.clear();
  $('workspace').hidden = true;
  $('login-panel').hidden = false;
  $('logout').hidden = true;
  $('identity').textContent = '';
  $('reply').value = '';
  renderMessages();
  $('conversations').replaceChildren();
  $('pages').replaceChildren();
}

$('domain').value = location.hostname;
$('login-form').onsubmit = async (event) => {
  event.preventDefault();
  $('login-button').disabled = true;
  notice('');
  try {
    const response = await fetch('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        identifier: $('email').value,
        password: $('password').value,
        domain_name: location.hostname,
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.success || !result.data?.token) throw new Error(result.message || 'Login failed.');
    token = result.data.token;
    sessionStorage.setItem('facebook_saas_jwt', token);
    sessionStorage.setItem('facebook_saas_name', result.data.data?.name || $('email').value);
    $('password').value = '';
    await init();
  } catch (e) {
    notice(e.message);
  } finally {
    $('login-button').disabled = false;
  }
};
$('logout').onclick = logOut;
$('integration-tab').onclick = () => showTab('integrations');
$('inbox-tab').onclick = () => showTab('inbox');

async function authorize() {
  const result = await api('/oauth/start', { method: 'POST', body: '{}' });
  // The browser navigates to the actual Facebook-hosted authorization dialog.
  const url = new URL(result.authorization_url);
  if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com')
    throw new Error('Invalid Facebook authorization URL.');
  location.assign(url.toString());
}
$('connect').onclick = async () => {
  $('connect').disabled = true;
  try {
    await authorize();
  } catch (e) {
    notice(e.message);
    $('connect').disabled = !setup?.ready || !setup?.can_manage;
  }
};

async function loadCandidates() {
  if (!setup.can_manage) return;
  const result = await api('/oauth/pages');
  $('selection').hidden = result.status !== 'ready';
  $('page-select').replaceChildren(
    ...result.pages.map((page) => {
      const option = element('option', page.name + ' · ' + page.page_id);
      option.value = page.page_id;
      return option;
    }),
  );
  if (result.error) notice(result.error);
  else if (result.status === 'ready') notice('Facebook authorization completed. Select a Page to connect.', 'success');
}
$('select-page').onclick = async () => {
  $('select-page').disabled = true;
  try {
    const page = await api('/pages', { method: 'POST', body: JSON.stringify({ page_id: $('page-select').value }) });
    $('selection').hidden = true;
    notice(
      page.status === 'connected'
        ? page.name + ' is connected. Send a customer message in native Messenger to start a conversation.'
        : page.error,
      page.status === 'connected' ? 'success' : 'error',
    );
    await refresh();
  } catch (e) {
    notice(e.message);
  } finally {
    $('select-page').disabled = false;
  }
};

function renderPages() {
  $('pages').replaceChildren();
  if (!pages.length) $('pages').append(element('p', 'No Facebook Page connected yet.', 'muted'));
  for (const page of pages) {
    const card = element('article', undefined, 'card page-card');
    card.append(
      element('h2', page.name),
      element('p', 'Page ID: ' + page.page_id, 'page-id'),
      element('span', page.status.replaceAll('_', ' '), 'status ' + page.status),
    );
    if (page.connected_at)
      card.append(element('p', 'Connected ' + new Date(page.connected_at).toLocaleString(), 'muted'));
    if (page.error) card.append(element('p', page.error, 'page-error'));
    const actions = element('div', undefined, 'actions');
    if (setup.can_manage) {
      const reconnect = button('Reconnect', authorize, 'quiet');
      reconnect.disabled = !setup.ready;
      actions.append(reconnect);
      if (page.status !== 'disconnected')
        actions.append(
          button(
            'Disconnect',
            async () => {
              const result = await api('/pages/' + page.id + '/disconnect', { method: 'POST', body: '{}' });
              notice(
                result.warning || 'Page disconnected. Stored credentials removed.',
                result.warning ? 'error' : 'success',
              );
              await refresh();
              $('selection').hidden = true;
            },
            'quiet',
          ),
        );
      actions.append(
        button(
          'Delete stored integration',
          async () => {
            if (
              !window.confirm(
                'Disconnect this Page and permanently delete its stored Messenger conversations and messages?',
              )
            )
              return;
            const result = await api('/pages/' + page.id, { method: 'DELETE' });
            notice(
              result.warning || 'Stored integration and conversations deleted.',
              result.warning ? 'error' : 'success',
            );
            await refresh();
            $('selection').hidden = true;
          },
          'danger',
        ),
      );
    }
    const link = element('a', 'Open native Messenger');
    link.href = 'https://m.me/' + encodeURIComponent(page.page_id);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    actions.append(link);
    card.append(actions);
    $('pages').append(card);
  }
}

function renderConversations() {
  $('conversations').replaceChildren();
  const rows = [...conversations.values()].sort(
    (a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at),
  );
  if (!rows.length) $('conversations').append(element('p', 'No customer conversations yet.', 'muted'));
  for (const c of rows) {
    const node = button(
      c.page_name,
      () => openConversation(c.id),
      'conversation' + (c.id === activeId ? ' active' : ''),
    );
    node.append(
      element('span', 'Messenger', 'badge'),
      element('small', 'Customer · ' + c.psid),
      element('small', new Date(c.last_message_at).toLocaleString()),
    );
    $('conversations').append(node);
  }
  $('more-conversations').hidden = !conversationCursor;
}
async function openConversation(id) {
  activeId = id;
  messages.clear();
  messageCursor = null;
  attempt = null;
  $('reply').value = '';
  showTab('inbox');
  renderConversations();
  renderMessages();
  await refreshMessages();
}
function renderMessages() {
  const box = $('messages');
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  box.replaceChildren();
  for (const message of [...messages.values()].sort(
    (a, b) => Date.parse(a.event_at) - Date.parse(b.event_at) || a.id.localeCompare(b.id),
  )) {
    const node = element('article', undefined, 'message ' + message.direction);
    node.append(
      element('p', message.text),
      element(
        'small',
        (message.direction === 'inbound' ? 'Customer · ' : 'Page · ') +
          new Date(message.event_at).toLocaleString() +
          ' · ' +
          message.status,
        message.status === 'failed' ? 'failed' : '',
      ),
    );
    if (message.error) node.append(element('p', message.error, 'error-detail'));
    box.append(node);
  }
  if (nearEnd) box.scrollTop = box.scrollHeight;
  $('older').hidden = !messageCursor;
}
function updateThread(c) {
  $('thread-header').replaceChildren(
    element('h2', c.page_name),
    element('p', 'Messenger · Customer ' + c.psid, 'muted'),
  );
  const inWindow = c.can_reply && Date.parse(c.reply_window_ends_at) > Date.now();
  const enabled = inWindow && c.connection_status === 'connected';
  $('window-note').textContent =
    c.connection_status !== 'connected'
      ? 'The Page is disconnected or requires reconnection. Replies are unavailable.'
      : inWindow
        ? 'Reply window open until ' + new Date(c.reply_window_ends_at).toLocaleString()
        : c.reply_block_reason || 'The 24-hour reply window has closed. The customer must message the Page again.';
  $('reply').disabled = !enabled;
  $('send').disabled = !enabled || sending;
  if (!sending)
    $('reply-state').textContent = enabled ? 'Send a customer support reply through Meta.' : 'Reply unavailable.';
}
async function refreshMessages(before) {
  const id = activeId;
  if (!id) return;
  const result = await api(
    '/conversations/' + id + '/messages' + (before ? '?before=' + encodeURIComponent(before) : ''),
  );
  if (activeId !== id) return;
  for (const message of result.messages) messages.set(message.id, message);
  if (before || !messageCursor) messageCursor = result.next_cursor;
  conversations.set(id, result.conversation);
  updateThread(result.conversation);
  renderMessages();
}
$('older').onclick = async () => {
  try {
    if (messageCursor) await refreshMessages(messageCursor);
  } catch (e) {
    notice(e.message);
  }
};
$('more-conversations').onclick = async () => {
  try {
    if (!conversationCursor) return;
    const result = await api('/conversations?before=' + encodeURIComponent(conversationCursor));
    result.conversations.forEach((c) => conversations.set(c.id, c));
    conversationCursor = result.next_cursor;
    renderConversations();
  } catch (e) {
    notice(e.message);
  }
};

$('reply-form').onsubmit = async (event) => {
  event.preventDefault();
  if (!activeId || sending || !$('reply').value.trim()) return;
  const id = activeId,
    text = $('reply').value.trim();
  if (!attempt || attempt.conversationId !== id || attempt.text !== text)
    attempt = { id: crypto.randomUUID(), text, conversationId: id };
  sending = true;
  $('send').disabled = true;
  $('reply-state').textContent = 'Sending to Meta…';
  try {
    const result = await api('/conversations/' + id + '/messages', {
      method: 'POST',
      body: JSON.stringify({ text, client_request_id: attempt.id }),
    });
    if (activeId === id) {
      messages.set(result.id, result);
      renderMessages();
    }
    if (['sent', 'delivered', 'read'].includes(result.status)) {
      if (activeId === id) $('reply').value = '';
      attempt = null;
      notice('Reply confirmed by Meta.', 'success');
    } else notice(result.error || 'Reply is pending. Wait for confirmation before sending another copy.');
  } catch (e) {
    notice(
      e.message + ' Pressing Send again with the same text checks the same request; it does not send a duplicate.',
    );
  } finally {
    sending = false;
    if (activeId) {
      try {
        await refreshMessages();
      } catch (e) {
        notice(e.message);
      }
    }
  }
};

async function refresh() {
  if (polling || !token) return;
  polling = true;
  const epoch = generation;
  try {
    const [newPages, result] = await Promise.all([api('/pages'), api('/conversations')]);
    if (epoch !== generation || !token) return;
    pages = newPages;
    const validPages = new Set(pages.map((p) => p.id));
    for (const [id, c] of conversations) if (!validPages.has(c.page_connection_id)) conversations.delete(id);
    result.conversations.forEach((c) => conversations.set(c.id, c));
    if (conversations.size <= 100) conversationCursor = result.next_cursor;
    renderPages();
    renderConversations();
    if (activeId && !conversations.has(activeId)) {
      activeId = null;
      messages.clear();
      messageCursor = null;
      $('reply').disabled = true;
      $('send').disabled = true;
      $('thread-header').replaceChildren(element('h2', 'Select a conversation'));
      renderMessages();
    }
    if (activeId) await refreshMessages();
    $('sync').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('sync').textContent = 'Connection interrupted';
    notice(e.message);
  } finally {
    polling = false;
  }
}
async function init() {
  if (!token) return;
  setup = await api('/setup');
  $('login-panel').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('identity').textContent = sessionStorage.getItem('facebook_saas_name') || 'Signed in';
  $('connect').disabled = !setup.ready || !setup.can_manage;
  $('configuration').hidden = setup.ready && setup.privacy_ready;
  $('configuration').textContent = [
    setup.issue,
    !setup.privacy_ready ? 'Deployment setup: configure the privacy controller and contact before App Review.' : null,
  ]
    .filter(Boolean)
    .join('\n');
  if (!setup.can_manage) {
    showTab('inbox');
    $('integration-tab').hidden = true;
  } else $('integration-tab').hidden = false;
  await loadCandidates();
  await refresh();
  history.replaceState(null, '', location.pathname);
}
if (token) init().catch((e) => notice(e.message));
// Database-backed polling works across API replicas and catches up after sleep or
// connection loss. The UI never depends on the WhatsApp socket bridge's room rules.
setInterval(() => {
  if (token && setup && !document.hidden) refresh();
}, 2000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token && setup) refresh();
});
