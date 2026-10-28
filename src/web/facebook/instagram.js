'use strict';
const $ = (id) => document.getElementById(id);
const base = '/v1/admin/instagram';
let token = sessionStorage.getItem('facebook_saas_jwt') || '';
let account,
  conversation,
  media,
  generation = 0;
const cursors = {};
let publishRequestId, uploadedPublishAsset, previewObjectUrl, publishingPoll;
let publishingAllowed = false;
function notice(text = '', success = false) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
  $('notice').className = success ? 'success' : 'error';
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, run, className = 'quiet') {
  const node = el('button', label, className);
  node.type = 'button';
  node.onclick = () => busy(node, run);
  return node;
}
async function busy(node, run) {
  node.disabled = true;
  notice();
  try {
    await run();
  } catch (e) {
    notice(e.message);
  } finally {
    node.disabled = false;
  }
}
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(45000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    if (response.status === 401) logout();
    throw new Error(result.message || 'Instagram operation failed.');
  }
  return result.data;
}
function clearAccount() {
  generation++;
  account = conversation = media = null;
  for (const key of Object.keys(cursors)) delete cursors[key];
  for (const id of ['conversations', 'messages', 'media', 'comments']) $(id).replaceChildren();
  for (const id of ['account-workspace', 'thread', 'comments-panel']) $(id).hidden = true;
  $('message-text').value = '';
  resetPublisher();
  $('publications').replaceChildren();
  clearTimeout(publishingPoll);
}
function logout() {
  clearAccount();
  token = '';
  sessionStorage.removeItem('facebook_saas_jwt');
  $('workspace').hidden = $('logout').hidden = true;
  $('login-panel').hidden = false;
  $('accounts').replaceChildren();
  $('page-select').replaceChildren();
  $('selection').hidden = true;
}
$('logout').onclick = logout;
$('login-form').onsubmit = (event) => {
  event.preventDefault();
  busy($('login-button'), async () => {
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
    const data = await response.json();
    $('password').value = '';
    if (!response.ok || !data.success || !data.data?.token) throw new Error(data.message || 'Login failed.');
    token = data.data.token;
    sessionStorage.setItem('facebook_saas_jwt', token);
    await init();
  });
};
function connect(provider, node) {
  return busy(node, async () => {
    const result = await api('/oauth/start', 'POST', { provider }),
      url = new URL(result.authorization_url);
    const expectedHost = provider === 'instagram' ? 'www.instagram.com' : 'www.facebook.com';
    if (url.protocol !== 'https:' || url.hostname !== expectedHost) throw new Error('Invalid authorization URL.');
    location.assign(url.toString());
  });
}
$('connect').onclick = () => connect('instagram', $('connect'));
$('connect-facebook').onclick = () => connect('facebook', $('connect-facebook'));
async function candidates() {
  const result = await api('/oauth/pages');
  $('selection').hidden = result.status !== 'ready';
  $('page-select').replaceChildren(
    ...result.pages.map((p) => {
      const option = el('option', (p.page_name ? p.page_name + ' / ' : '') + '@' + (p.username || p.instagram_id));
      option.value = p.selection_id || p.page_id;
      return option;
    }),
  );
  if (result.error) notice(result.error);
}
$('select-page').onclick = () =>
  busy($('select-page'), async () => {
    const a = await api('/accounts', 'POST', { page_id: $('page-select').value });
    await candidates();
    await accounts();
    await openAccount(a);
    notice('Instagram account connected.', true);
  });
async function accounts() {
  const g = generation,
    rows = await api('/accounts');
  if (g !== generation) return;
  $('accounts').replaceChildren(
    ...rows.map((a) => {
      const card = el('article', undefined, 'card');
      card.append(
        el('h2', '@' + a.username),
        el('p', 'Instagram account ID: ' + a.instagram_id),
        el('p', (a.page_name ? a.page_name + ' · ' : '') + a.status.replaceAll('_', ' ')),
      );
      card.append(
        button('Open account', () => openAccount(a)),
        button('Disconnect', async () => {
          if (!confirm('Disconnect Instagram? Stored history will remain.')) return;
          await api('/accounts/' + a.id + '/disconnect', 'POST', {});
          clearAccount();
          await accounts();
        }),
        button(
          'Delete stored integration',
          async () => {
            if (!confirm('Delete this Instagram connection and its stored messages and comments?')) return;
            await api('/accounts/' + a.id, 'DELETE');
            clearAccount();
            await accounts();
          },
          'danger',
        ),
      );
      return card;
    }),
  );
  if (!rows.length) $('accounts').append(el('p', 'No Instagram accounts connected yet.', 'muted'));
}
const accountPath = () => '/accounts/' + account.id;
async function openAccount(a) {
  clearAccount();
  account = a;
  $('account-name').textContent = '@' + a.username;
  renderProfile(a);
  $('account-workspace').hidden = false;
  await renderConversations();
  await renderMedia();
  await loadPublisher();
}
function renderProfile(a) {
  $('profile-username').textContent = '@' + a.username;
  $('profile-id').textContent = a.instagram_id;
  $('profile-status').textContent = a.status.replaceAll('_', ' ');
  $('profile-link').href = 'https://www.instagram.com/' + encodeURIComponent(a.username) + '/';
  $('refresh-profile').disabled = a.status !== 'connected';
}
$('refresh-profile').onclick = () =>
  busy($('refresh-profile'), async () => {
    const current = account?.id,
      g = generation;
    if (!current) return;
    const updated = await api('/accounts/' + current + '/profile/sync', 'POST', {});
    if (g !== generation || account?.id !== current) return;
    account = updated;
    $('account-name').textContent = '@' + updated.username;
    renderProfile(updated);
    await accounts();
    notice('Instagram profile refreshed.', true);
  });
function resetPublisher() {
  publishRequestId = null;
  uploadedPublishAsset = null;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
  $('publish-form').reset();
  updatePublishingInput();
}
function updatePublishingInput() {
  const reel = $('publish-kind').value === 'REELS',
    upload = $('publish-source').value === 'upload';
  $('publish-file-label').hidden = !upload;
  $('publish-url-label').hidden = upload;
  $('publish-feed-label').hidden = !reel;
  $('publish-file').accept = reel ? 'video/mp4' : 'image/jpeg';
  $('publish-photo-preview').hidden = true;
  $('publish-video-preview').hidden = true;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
  const file = $('publish-file').files[0];
  if (upload && file) {
    previewObjectUrl = URL.createObjectURL(file);
    const preview = $(reel ? 'publish-video-preview' : 'publish-photo-preview');
    preview.src = previewObjectUrl;
    preview.hidden = false;
  }
}
for (const id of ['publish-kind', 'publish-source', 'publish-file', 'publish-url'])
  $(id).onchange = () => {
    publishRequestId = null;
    uploadedPublishAsset = null;
    updatePublishingInput();
  };
for (const id of ['publish-caption', 'publish-feed'])
  $(id).oninput = () => {
    publishRequestId = null;
  };
$('new-post-draft').onclick = resetPublisher;
async function loadPublisher() {
  const current = account?.id,
    g = generation;
  if (!current) return;
  const [settings, rows] = await Promise.all([
    api(accountPath() + '/publishing'),
    api(accountPath() + '/publications'),
  ]);
  if (g !== generation || account?.id !== current) return;
  publishingAllowed = settings.allowed;
  $('publish-fields').disabled = !settings.allowed;
  $('publish-account').textContent = 'Publishing to @' + account.username;
  $('publish-issue').textContent =
    settings.issue ||
    (!settings.permission_verified
      ? 'Reconnect with Instagram once to grant publishing access before your first post.'
      : '');
  $('publish-issue').hidden = !$('publish-issue').textContent;
  renderPublications(rows);
}
$('publish-form').onsubmit = (event) => {
  event.preventDefault();
  busy($('prepare-post'), async () => {
    if (!account || !publishingAllowed) throw new Error('Reconnect with Instagram and grant publishing access.');
    const current = account.id,
      g = generation,
      kind = $('publish-kind').value;
    const caption = $('publish-caption').value,
      shareToFeed = $('publish-feed').checked;
    publishRequestId ||= crypto.randomUUID();
    const requestId = publishRequestId;
    let mediaUrl = $('publish-url').value.trim(),
      assetId;
    if ($('publish-source').value === 'upload') {
      const file = $('publish-file').files[0];
      if (!file) throw new Error('Choose a JPEG photo or MP4 Reel.');
      if (file.type !== (kind === 'IMAGE' ? 'image/jpeg' : 'video/mp4'))
        throw new Error('The file must match the selected post type.');
      if (file.size > (kind === 'IMAGE' ? 8 : 100) * 1024 * 1024)
        throw new Error(
          kind === 'IMAGE' ? 'JPEG photos must be 8 MB or smaller.' : 'MP4 Reels must be 100 MB or smaller.',
        );
      if (!uploadedPublishAsset) {
        const form = new FormData();
        form.append('file', file);
        const response = await fetch(base + '/accounts/' + current + '/publishing/uploads', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          credentials: 'same-origin',
          body: form,
          signal: AbortSignal.timeout(120000),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || 'Media upload failed.');
        if (g !== generation || account?.id !== current || publishRequestId !== requestId) return;
        uploadedPublishAsset = result.data;
      }
      mediaUrl = uploadedPublishAsset.media_url;
      assetId = uploadedPublishAsset.asset_id;
    }
    if (!mediaUrl) throw new Error('Enter a public HTTPS media URL.');
    if (g !== generation || account?.id !== current || publishRequestId !== requestId) return;
    const post = await api('/accounts/' + current + '/publications', 'POST', {
      kind,
      caption,
      media_url: mediaUrl,
      asset_id: assetId,
      share_to_feed: shareToFeed,
      client_request_id: requestId,
    });
    if (g !== generation || account?.id !== current) return;
    await loadPublisher();
    if (post.status === 'processing') pollPublication(post.id, 0, current, g);
    notice(
      post.status === 'ready'
        ? 'Media ready. Review the caption and choose Publish to Instagram.'
        : post.error || 'Instagram is preparing your media.',
      post.status !== 'failed',
    );
  });
};
function pollPublication(id, attempt, current, g) {
  clearTimeout(publishingPoll);
  if (attempt >= 5) return;
  publishingPoll = setTimeout(async () => {
    if (generation !== g || account?.id !== current || document.hidden) return;
    try {
      const row = await api('/accounts/' + current + '/publications/' + id + '/status', 'POST', {});
      if (generation !== g || account?.id !== current) return;
      await loadPublisher();
      if (row.status === 'processing') pollPublication(id, attempt + 1, current, g);
    } catch (e) {
      notice(e.message);
    }
  }, 60000);
}
function renderPublications(rows) {
  $('publications').replaceChildren(
    ...rows.map((row) => {
      const card = el('article');
      card.append(
        el('strong', (row.kind === 'REELS' ? 'Reel' : 'Photo') + ' · ' + row.status),
        el('p', row.caption || '(No caption)'),
      );
      if (row.error) card.append(el('p', row.error));
      if (['creating', 'processing', 'ready', 'publishing', 'unconfirmed'].includes(row.status))
        card.append(
          button('Check status', async () => {
            await api(accountPath() + '/publications/' + row.id + '/status', 'POST', {});
            await loadPublisher();
          }),
        );
      if (row.status === 'ready')
        card.append(
          button(
            'Publish to Instagram',
            async () => {
              const current = account.id,
                g = generation;
              const result = await api(accountPath() + '/publications/' + row.id + '/publish', 'POST', {});
              if (g !== generation || account?.id !== current) return;
              await loadPublisher();
              await renderMedia();
              notice(
                result.status === 'published'
                  ? 'Post published on Instagram.'
                  : result.error || 'Publication is awaiting confirmation. Check status before creating another post.',
                result.status === 'published',
              );
            },
            '',
          ),
        );
      if (['publishing', 'unconfirmed'].includes(row.status))
        card.append(el('p', 'Check Instagram before making another post. This publication will not be sent twice.'));
      if (row.permalink && /^https:\/\/(www\.)?instagram\.com\//.test(row.permalink)) {
        const link = el('a', 'View published post');
        link.href = row.permalink;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.append(link);
      } else if (row.status === 'published')
        card.append(el('p', 'Published. Refresh posts or open Instagram to view it.'));
      return card;
    }),
  );
}
$('refresh-publications').onclick = () => busy($('refresh-publications'), loadPublisher);
async function importRows(kind, more = false) {
  if (!account) return;
  const g = generation,
    a = account.id,
    c = conversation?.id,
    m = media?.id;
  const path =
    accountPath() +
    (kind === 'conversations' || kind === 'media'
      ? '/' + kind
      : kind === 'messages'
        ? '/conversations/' + c
        : '/media/' + m) +
    '/sync';
  const result = await api(path, 'POST', more ? { after: cursors[kind] } : {});
  if (
    g !== generation ||
    account?.id !== a ||
    (kind === 'messages' && conversation?.id !== c) ||
    (kind === 'comments' && media?.id !== m)
  )
    return;
  cursors[kind] = result.next_cursor;
  $('more-' + kind).hidden = !result.next_cursor;
  if (kind === 'conversations') await renderConversations();
  if (kind === 'media') await renderMedia();
  if (kind === 'messages') await renderMessages();
  if (kind === 'comments') await renderComments();
}
for (const kind of ['conversations', 'messages', 'media', 'comments']) {
  $('refresh-' + kind).onclick = () => busy($('refresh-' + kind), () => importRows(kind));
  $('more-' + kind).onclick = () => busy($('more-' + kind), () => importRows(kind, true));
}
async function renderConversations() {
  const g = generation,
    rows = await api(accountPath() + '/conversations');
  if (g !== generation) return;
  $('conversations').replaceChildren(
    ...rows.map((c) =>
      button(c.payload.username || c.remote_id, async () => {
        conversation = c;
        cursors.messages = null;
        $('more-messages').hidden = true;
        $('thread-name').textContent = c.payload.username || c.remote_id;
        $('thread').hidden = false;
        $('message-text').value = '';
        await renderMessages();
        await importRows('messages');
      }),
    ),
  );
  if (!rows.length)
    $('conversations').append(el('p', 'Send a DM from another Instagram account, then refresh the inbox.', 'muted'));
}
async function renderMessages() {
  const g = generation,
    c = conversation?.id;
  if (!c) return;
  const result = await api(accountPath() + '/conversations/' + c + '/messages');
  if (g !== generation || conversation?.id !== c) return;
  $('messages').replaceChildren(
    ...result.messages
      .slice()
      .reverse()
      .map((m) => {
        const card = el('article', undefined, 'card');
        card.append(
          el('small', (m.payload.incoming ? 'Customer' : 'You') + ' · ' + new Date(m.event_at).toLocaleString()),
          el('p', m.payload.text),
        );
        return card;
      }),
  );
  $('send-message').disabled = !result.can_reply;
  $('reply-window').textContent = result.can_reply
    ? 'Reply window closes ' + new Date(result.reply_window_ends_at).toLocaleString()
    : 'Ask the customer to send a DM to open the 24-hour reply window.';
}
$('reply-form').onsubmit = (event) => {
  event.preventDefault();
  const a = account?.id,
    c = conversation?.id,
    text = $('message-text').value;
  if (!a || !c) return;
  busy($('send-message'), async () => {
    const result = await api('/accounts/' + a + '/conversations/' + c + '/messages', 'POST', {
      text,
      client_request_id: crypto.randomUUID(),
    });
    if (account?.id !== a || conversation?.id !== c) return;
    if (result.status !== 'confirmed') throw new Error('Reply not confirmed. Check Instagram before sending again.');
    $('message-text').value = '';
    notice('Reply sent to Instagram.', true);
    await renderMessages();
  });
};
async function renderMedia() {
  const g = generation,
    rows = await api(accountPath() + '/media');
  if (g !== generation) return;
  $('media').replaceChildren(
    ...rows.map((m) => {
      const card = el('article', undefined, 'card');
      card.append(el('p', m.payload.caption || m.payload.media_type || 'Instagram post'));
      try {
        const url = new URL(m.payload.permalink);
        if (url.protocol === 'https:' && ['www.instagram.com', 'instagram.com'].includes(url.hostname)) {
          const link = el('a', 'View on Instagram');
          link.href = url.toString();
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          card.append(link);
        }
      } catch {}
      card.append(
        button('Read comments', async () => {
          media = m;
          cursors.comments = null;
          $('more-comments').hidden = true;
          $('comments-panel').hidden = false;
          $('comments-title').textContent = 'Comments · ' + (m.payload.caption || m.remote_id).slice(0, 80);
          await renderComments();
          await importRows('comments');
        }),
      );
      return card;
    }),
  );
  if (!rows.length) $('media').append(el('p', 'Click Refresh posts to load your published Instagram posts.', 'muted'));
}
async function renderComments() {
  const g = generation,
    m = media?.id;
  if (!m) return;
  const rows = await api(accountPath() + '/media/' + m + '/comments');
  if (g !== generation || media?.id !== m) return;
  const a = account.id;
  $('comments').replaceChildren(
    ...rows.map((c) => {
      const card = el('article', undefined, 'card');
      card.append(
        el('h3', c.payload.username || 'Instagram user'),
        el('p', c.payload.text),
        el('p', c.payload.hidden ? 'Hidden' : 'Visible'),
      );
      const form = el('form'),
        label = el('label', 'Public reply'),
        input = el('textarea');
      input.maxLength = 1000;
      input.required = true;
      label.append(input);
      const submit = el('button', 'Reply to comment');
      form.append(label, submit);
      form.onsubmit = (event) => {
        event.preventDefault();
        busy(submit, async () => {
          const result = await api('/accounts/' + a + '/comments/' + c.id + '/replies', 'POST', {
            text: input.value,
            client_request_id: crypto.randomUUID(),
          });
          if (result.status !== 'confirmed') throw new Error('Comment reply not confirmed. Check Instagram.');
          input.value = '';
          card.append(el('p', 'Reply published on Instagram.'));
          notice('Comment reply published.', true);
        });
      };
      card.append(
        form,
        button(c.payload.hidden ? 'Unhide comment' : 'Hide comment', async () => {
          const result = await api('/accounts/' + a + '/comments/' + c.id, 'PATCH', {
            hidden: !c.payload.hidden,
            client_request_id: crypto.randomUUID(),
          });
          if (result.status !== 'confirmed') throw new Error('Comment change not confirmed. Check Instagram.');
          if (account?.id === a && media?.id === m) await renderComments();
          notice('Comment visibility updated.', true);
        }),
      );
      return card;
    }),
  );
  if (!rows.length)
    $('comments').append(el('p', 'No comments imported. Add a comment from another account and refresh.', 'muted'));
}
async function init() {
  const setup = await api('/setup');
  $('workspace').hidden = $('logout').hidden = false;
  $('login-panel').hidden = true;
  const direct = setup.providers?.find((p) => p.provider === 'instagram');
  const facebook = setup.providers?.find((p) => p.provider === 'facebook');
  $('configuration').textContent = direct?.issue || '';
  $('configuration').hidden = !direct?.issue;
  $('connect').disabled = !direct?.ready;
  $('connect-facebook').disabled = !facebook?.ready;
  await accounts();
  await candidates();
  if (location.hash.startsWith('#oauth=')) history.replaceState(null, '', location.pathname);
}
if (token) init().catch((e) => notice(e.message));
