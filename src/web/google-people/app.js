(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    base = '/v1/admin/google-people';
  const initial = $('person').value;
  const state = {
    token: '',
    connected: false,
    ready: false,
    busy: false,
    waiting: false,
    next: null,
    resource: null,
    etag: null,
    timer: null,
    popup: null,
    generation: 0,
  };
  function notice(message) {
    $('notice').textContent = message;
  }
  function render() {
    const signed = Boolean(state.token),
      locked = state.busy || state.waiting;
    $('login-form').hidden = signed;
    $('identity').hidden = !signed;
    $('logout').hidden = !signed;
    for (const id of ['save-app', 'remove-app']) $(id).disabled = !signed || locked;
    $('connect').disabled = !signed || !state.ready || locked;
    $('disconnect').disabled = !signed || !state.connected || locked;
    for (const id of ['load', 'read', 'save-contact', 'new-contact'])
      $(id).disabled = !signed || !state.connected || locked;
    $('next').disabled = !signed || !state.connected || !state.next || locked;
    $('connection-status').textContent = state.connected
      ? 'Google Contacts connected.'
      : signed
        ? 'Google Contacts is not connected.'
        : 'Sign in first.';
    $('editor-heading').textContent = state.resource ? '4. Edit contact' : '4. Create a contact';
    $('save-contact').textContent = state.resource ? 'Save changes' : 'Create contact';
  }
  async function api(url, method = 'GET', data) {
    const response = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw Error('The server returned an unexpected page. Open the app address and check the tunnel.');
    }
    if (!response.ok || !body.success) throw Error(body.message || 'Request failed.');
    return body.data;
  }
  async function run(action) {
    if (state.busy || state.waiting) return;
    state.busy = true;
    render();
    try {
      await action();
    } catch (error) {
      notice(error.message || 'Request failed.');
    } finally {
      state.busy = false;
      render();
    }
  }
  function stopWaiting() {
    clearInterval(state.timer);
    state.timer = null;
    state.waiting = false;
    state.generation++;
    try {
      state.popup?.close();
    } catch {}
    state.popup = null;
  }
  function resetEditor() {
    state.resource = null;
    state.etag = null;
    $('person').value = initial;
    $('result').textContent = '';
    render();
  }
  async function connection() {
    state.connected = (await api(`${base}/connection`)).connected;
    render();
  }
  async function setup() {
    const data = await api(`${base}/setup`);
    state.ready = data.ready;
    $('callback').textContent = data.redirect_uri;
    $('client-id').value = data.client_id || '';
    if (!data.ready) notice(data.issue);
    await connection();
  }
  $('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const password = $('password').value;
      $('password').value = '';
      const login = await api('/v1/auth/login', 'POST', {
        identifier: $('email').value.trim(),
        password,
        domain_name: $('domain').value.trim(),
      });
      if (!login.token) throw Error('The login did not return a session token.');
      state.token = login.token;
      try {
        await setup();
        notice('Signed in. Connect Google Contacts to continue.');
      } catch (error) {
        state.token = '';
        throw error;
      }
    });
  });
  $('logout').addEventListener('click', () => {
    stopWaiting();
    state.token = '';
    state.connected = false;
    state.next = null;
    $('contacts').replaceChildren();
    $('person-id').value = '';
    $('client-id').value = '';
    $('client-secret').value = '';
    resetEditor();
    notice('Session cleared from this page.');
  });
  $('app-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const secret = $('client-secret').value;
      $('client-secret').value = '';
      await api(`${base}/oauth-app`, 'PUT', { client_id: $('client-id').value.trim(), client_secret: secret });
      $('contacts').replaceChildren();
      resetEditor();
      await setup();
      notice('Account credentials saved. Connect Google Contacts again.');
    });
  });
  $('remove-app').addEventListener('click', () =>
    run(async () => {
      await api(`${base}/oauth-app`, 'DELETE');
      $('contacts').replaceChildren();
      resetEditor();
      await setup();
      notice('Account OAuth credentials removed.');
    }),
  );
  $('connect').addEventListener('click', () => {
    if (state.busy || state.waiting) return;
    const popup = window.open('about:blank', 'soft7-google-people', 'width=700,height=800');
    if (!popup) return notice('Allow pop-up windows, then connect again.');
    run(async () => {
      try {
        const before = (await api(`${base}/connection`)).connection?.updated_at;
        const data = await api(`${base}/oauth/start`, 'POST', {}),
          target = new URL(data.authorization_url);
        if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth')
          throw Error('Unexpected Google authorization URL.');
        state.popup = popup;
        state.waiting = true;
        const generation = ++state.generation;
        const deadline = Date.now() + 600000;
        let polling = false;
        popup.location.href = target.toString();
        notice('Complete Google authorization in the new window.');
        state.timer = setInterval(async () => {
          if (polling || generation !== state.generation || !state.token) return;
          polling = true;
          try {
            const result = await api(`${base}/connection`);
            if (result.connected && result.connection?.updated_at !== before) {
              state.connected = true;
              stopWaiting();
              notice('Google Contacts connected.');
              render();
            } else if (Date.now() >= deadline) {
              stopWaiting();
              notice('Connection timed out. Try connecting again.');
              render();
            }
          } catch (error) {
            stopWaiting();
            notice(error.message);
            render();
          } finally {
            polling = false;
          }
        }, 2500);
      } catch (error) {
        popup.close();
        throw error;
      }
    });
  });
  $('disconnect').addEventListener('click', () =>
    run(async () => {
      await api(`${base}/connection`, 'DELETE');
      state.connected = false;
      state.next = null;
      $('contacts').replaceChildren();
      resetEditor();
      notice('Google Contacts disconnected from this app.');
    }),
  );
  async function read(resourceName) {
    const id = resourceName.replace(/^people\//, '');
    const person = await api(`${base}/contacts/${encodeURIComponent(id)}`);
    const source = person.metadata?.sources?.find((source) => source.type === 'CONTACT');
    if (!source?.etag) throw Error('This record has no editable contact source.');
    state.resource = person.resourceName;
    state.etag = source.etag;
    const editable = {};
    const keys = {
      names: ['givenName', 'middleName', 'familyName', 'honorificPrefix', 'honorificSuffix'],
      emailAddresses: ['value', 'type'],
      phoneNumbers: ['value', 'type'],
    };
    for (const [field, fields] of Object.entries(keys))
      if (person[field])
        editable[field] = person[field].map((row) =>
          Object.fromEntries(fields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]])),
        );
    $('person').value = JSON.stringify(editable, null, 2);
    $('person-id').value = state.resource;
    $('result').textContent = JSON.stringify(person, null, 2);
    render();
    notice('Contact loaded. Edit the JSON, then save changes.');
  }
  async function list(next = false) {
    const result = await api(
      `${base}/contacts?page_size=50${next && state.next ? '&page_token=' + encodeURIComponent(state.next) : ''}`,
    );
    state.next = result.nextPageToken || null;
    $('contacts').replaceChildren();
    for (const person of result.connections || []) {
      const line = document.createElement('p'),
        label = document.createElement('span'),
        button = document.createElement('button');
      label.textContent = `${person.names?.[0]?.displayName || person.emailAddresses?.[0]?.value || person.resourceName} `;
      button.textContent = 'Edit';
      button.addEventListener('click', () => run(() => read(person.resourceName)));
      line.append(label, button);
      $('contacts').append(line);
    }
    if (!result.connections?.length) $('contacts').textContent = 'No contacts on this page.';
    render();
  }
  $('load').addEventListener('click', () => run(() => list()));
  $('next').addEventListener('click', () => run(() => list(true)));
  $('read-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(() => read($('person-id').value.trim()));
  });
  $('new-contact').addEventListener('click', resetEditor);
  $('contact-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      let person;
      try {
        person = JSON.parse($('person').value);
      } catch {
        throw Error('Enter valid contact JSON.');
      }
      const editing = Boolean(state.resource);
      const result = editing
        ? await api(`${base}/contacts/${encodeURIComponent(state.resource.replace(/^people\//, ''))}`, 'PATCH', {
            ...person,
            source_etag: state.etag,
          })
        : await api(`${base}/contacts`, 'POST', person);
      state.resource = result.resourceName;
      state.etag = result.metadata?.sources?.find((source) => source.type === 'CONTACT')?.etag || null;
      $('result').textContent = JSON.stringify(result, null, 2);
      $('person-id').value = result.resourceName;
      notice(editing ? 'Contact updated in Google Contacts.' : 'Contact created in Google Contacts.');
      render();
    });
  });
  window.addEventListener('beforeunload', stopWaiting);
  api('/v1/integrations/google-people/setup')
    .then((data) => {
      $('callback').textContent = data.redirect_uri;
      $('domain').value = data.login_domain || location.hostname;
    })
    .catch((error) => notice(error.message));
  render();
})();
