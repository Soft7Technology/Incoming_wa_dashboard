'use strict';
const $ = (id) => document.getElementById(id);
const apiBase = '/v1/facebook/api/leads';
let sessionReady = false;
let activePage,
  activeForm,
  formCursor,
  leadCursor,
  refreshing = false,
  generation = 0;
let browsingOlder = false,
  leadRenderSequence = 0;
let setup;

function notice(text, type = 'error') {
  $('notice').textContent = text;
  $('notice').className = type;
  $('notice').hidden = !text;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function action(text, fn, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.onclick = async () => {
    node.disabled = true;
    try {
      await fn();
    } catch (e) {
      notice(e.message);
    } finally {
      node.disabled = false;
    }
  };
  return node;
}
async function api(path, options = {}) {
  const response = await window.metaWorkspace.fetch(apiBase + path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.message || 'Request failed.');
  }
  return result.data;
}
$('connect').onclick = async () => {
  $('connect').disabled = true;
  try {
    if (setup?.preset_ready) {
      const page = await api('/preset/connect', { method: 'POST', body: '{}' });
      await loadPages();
      if (page.status !== 'connected') throw new Error(page.error || 'Facebook webhook subscription failed.');
      notice('Page connected using the saved Facebook token.', 'success');
      await showForms(page);
      $('connect').disabled = false;
      return;
    }
    const result = await api('/oauth/start', { method: 'POST', body: '{}' });
    const url = new URL(result.authorization_url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com')
      throw new Error('Invalid Facebook authorization URL.');
    location.assign(url.toString());
  } catch (e) {
    notice(e.message);
    $('connect').disabled = false;
  }
};
$('token-form').onsubmit = async (event) => {
  event.preventDefault();
  const input = $('facebook-token').value.trim();
  $('facebook-token').value = '';
  $('token-button').disabled = true;
  notice('');
  try {
    await api('/token', { method: 'POST', body: JSON.stringify({ access_token: input }) });
    $('token-connection').open = false;
    await candidates();
    notice('Token verified. Select your Facebook Page to connect.', 'success');
  } catch (e) {
    notice(e.message);
  } finally {
    $('token-button').disabled = false;
  }
};
$('connect-another').onclick = async () => {
  $('connect-another').disabled = true;
  notice('');
  try {
    await api('/preset/pages', { method: 'POST', body: '{}' });
    await candidates();
    notice('Choose a Page from your saved Facebook connection.', 'success');
    $('selection').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    notice(e.message);
  } finally {
    $('connect-another').disabled = false;
  }
};
async function candidates() {
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
  else if (result.status === 'ready') notice('Facebook access granted. Choose your Page.', 'success');
}
$('select-page').onclick = async () => {
  $('select-page').disabled = true;
  try {
    const page = await api('/pages', { method: 'POST', body: JSON.stringify({ page_id: $('page-select').value }) });
    await candidates();
    await loadPages();
    notice(
      page.status === 'connected' ? 'Page connected. Lead webhook subscription verified.' : page.error,
      page.status === 'connected' ? 'success' : 'error',
    );
    if (page.status === 'connected') await showForms(page);
  } catch (e) {
    notice(e.message);
  } finally {
    $('select-page').disabled = false;
  }
};
async function loadPages() {
  const current = generation,
    pages = await api('/pages');
  if (current !== generation) return;
  $('pages').replaceChildren(
    ...pages.map((page) => {
      const card = element('article', undefined, 'card');
      card.append(
        element('h3', page.name),
        element('p', 'Page ' + page.page_id, 'muted'),
        element(
          'p',
          page.status === 'connected' ? 'Connected · lead webhook verified' : page.status.replaceAll('_', ' '),
        ),
      );
      if (page.error) card.append(element('p', page.error));
      const open = action('Choose forms', () => showForms(page));
      open.disabled = page.status !== 'connected';
      card.append(open);
      const remove = async (erase) => {
        if (
          !confirm(
            erase
              ? 'Delete this Page integration and all stored forms and leads?'
              : 'Disconnect this Page and stop lead syncing?',
          )
        )
          return;
        const result = await api('/pages/' + page.id + (erase ? '' : '/disconnect'), {
          method: erase ? 'DELETE' : 'POST',
          body: erase ? undefined : '{}',
        });
        if (activePage?.id === page.id) {
          generation++;
          activePage = activeForm = null;
          $('forms-panel').hidden = $('leads-panel').hidden = true;
          $('forms').replaceChildren();
          $('leads').replaceChildren();
        }
        await loadPages();
        notice(
          result.warning || (erase ? 'Stored integration deleted.' : 'Page disconnected.'),
          result.warning ? 'error' : 'success',
        );
      };
      card.append(
        action('Disconnect', () => remove(false), 'quiet'),
        action('Delete stored integration', () => remove(true), 'quiet'),
      );
      return card;
    }),
  );
  if (!pages.length) $('pages').append(element('p', 'Connect Facebook to choose a Page.', 'muted'));
  return pages;
}
async function showForms(page, after) {
  if (!after) {
    generation++;
    activePage = page;
    activeForm = null;
    $('forms').replaceChildren();
    $('leads').replaceChildren();
    $('leads-panel').hidden = true;
    $('forms-title').textContent = '2. Choose a form · ' + page.name;
  }
  const current = generation;
  const result = await api('/pages/' + page.id + '/forms' + (after ? '?after=' + encodeURIComponent(after) : ''));
  if (current !== generation) return;
  formCursor = result.next_cursor;
  $('more-forms').hidden = !formCursor;
  $('forms-panel').hidden = false;
  $('forms').replaceChildren(
    ...result.forms.map((form) => {
      const card = element('article', undefined, 'card');
      card.append(
        element('h3', form.name),
        element('p', 'Form ' + form.form_id + ' · ' + (form.status || 'Available'), 'muted'),
      );
      const questions = element('details');
      questions.append(element('summary', 'Form questions'));
      for (const question of form.questions || [])
        questions.append(element('p', question.label || question.key || question.type || 'Question'));
      card.append(questions, element('p', form.enabled ? 'Automatic syncing enabled' : 'Syncing disabled'));
      if (form.last_synced_at)
        card.append(element('small', 'Last sync: ' + new Date(form.last_synced_at).toLocaleString()));
      if (form.sync_error) card.append(element('p', form.sync_error));
      card.append(
        action(form.enabled ? 'Disable syncing' : 'Enable syncing', async () => {
          await api('/forms/' + form.id, { method: 'PATCH', body: JSON.stringify({ enabled: !form.enabled }) });
          await showForms(page);
          notice(
            form.enabled ? 'Form syncing disabled.' : 'Form syncing enabled. Import existing leads next.',
            'success',
          );
        }),
      );
      const sync = action('Sync existing leads', async () => {
        let after,
          count = 0,
          pages = 0;
        const visited = new Set();
        do {
          const result = await api('/forms/' + form.id + '/sync', { method: 'POST', body: JSON.stringify({ after }) });
          if (current !== generation) return;
          count += result.imported;
          after = result.next_cursor;
          notice('Syncing leads… ' + count + ' new leads imported.', 'success');
          if (after && visited.has(after)) throw new Error('Meta pagination repeated. Retry syncing.');
          visited.add(after);
          if (++pages >= 1000 && after)
            throw new Error('Sync paused after 1,000 batches. Use the API cursor to continue.');
        } while (after);
        await viewLeads(form);
        notice('Sync complete. ' + count + ' new leads imported; duplicate submissions are skipped.', 'success');
      });
      sync.disabled = !form.enabled;
      card.append(
        sync,
        action('View submitted leads', () => viewLeads(form), 'quiet'),
      );
      return card;
    }),
  );
  if (!result.forms.length)
    $('forms').append(
      element('p', 'No Instant Forms returned. Create a form on this Page in Meta, then choose forms again.', 'muted'),
    );
  if (setup?.preset_ready && result.forms.length === 1 && result.forms[0].enabled) await viewLeads(result.forms[0]);
}
$('more-forms').onclick = async () => {
  try {
    await showForms(activePage, formCursor);
  } catch (e) {
    notice(e.message);
  }
};
$('reload-forms').onclick = async () => {
  try {
    await showForms(activePage);
  } catch (e) {
    notice(e.message);
  }
};
async function viewLeads(form, before) {
  if (!before && activeForm?.id !== form.id) {
    activeForm = form;
    $('leads').replaceChildren();
  }
  browsingOlder = Boolean(before);
  const sequence = ++leadRenderSequence;
  const current = generation,
    result = await api('/forms/' + form.id + '/leads' + (before ? '?before=' + encodeURIComponent(before) : ''));
  if (current !== generation || sequence !== leadRenderSequence || activeForm?.id !== form.id) return;
  $('leads-panel').hidden = false;
  $('leads-title').textContent = '3. Submitted leads · ' + form.name;
  if (!before) $('leads').replaceChildren();
  for (const lead of result.leads) {
    const card = element('article', undefined, 'card');
    card.append(
      element('h3', 'Lead ' + lead.lead_id),
      element('p', new Date(lead.submitted_at).toLocaleString(), 'muted'),
    );
    const answers = element('dl');
    for (const field of lead.field_data)
      answers.append(element('dt', field.name.replaceAll('_', ' ')), element('dd', field.values.join(', ')));
    card.append(answers);
    $('leads').append(card);
  }
  if (!before && !result.leads.length)
    $('leads').append(
      element(
        'p',
        'No leads synced yet. Enable this form and sync existing submissions or submit a new test lead.',
        'muted',
      ),
    );
  leadCursor = result.next_cursor;
  $('more-leads').hidden = !leadCursor;
  $('last-refresh').textContent = browsingOlder
    ? 'Viewing older leads · Refresh to return to live updates'
    : 'Updated ' + new Date().toLocaleTimeString() + ' · refreshes every 5 seconds';
}
$('refresh-leads').onclick = async () => {
  try {
    await viewLeads(activeForm);
  } catch (e) {
    notice(e.message);
  }
};
$('more-leads').onclick = async () => {
  try {
    await viewLeads(activeForm, leadCursor);
  } catch (e) {
    notice(e.message);
  }
};
async function init() {
  setup = await api('/setup');
  $('workspace').hidden = false;
  $('connect').disabled = !setup.ready && !setup.preset_ready;
  $('connect').textContent = setup.preset_ready ? 'Connect ' + setup.preset_page_name : 'Connect Facebook Page';
  $('connect-another').hidden = !setup.preset_ready;
  $('token-connection').hidden = false;
  $('token-button').disabled = !setup.token_ready;
  $('configuration').hidden = setup.preset_ready || !setup.issue;
  $('configuration').textContent = setup.preset_ready ? '' : setup.issue || '';
  await candidates();
  const connectedPages = await loadPages();
  const savedPage =
    setup.preset_ready &&
    connectedPages?.find(
      (page) =>
        page.status === 'connected' &&
        (setup.preset_page_id ? page.page_id === setup.preset_page_id : page.name === setup.preset_page_name),
    );
  if (savedPage) await showForms(savedPage);
  history.replaceState(null, '', location.pathname);
}
setInterval(async () => {
  if (!sessionReady || !activeForm || document.hidden || refreshing || browsingOlder) return;
  refreshing = true;
  try {
    await viewLeads(activeForm);
  } catch (e) {
    notice(e.message);
  } finally {
    refreshing = false;
  }
}, 5000);
window.metaWorkspace.ready().then(() => { sessionReady = true; return init(); }).catch((e) => notice(e.message));
