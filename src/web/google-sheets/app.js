'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const base = '/v1/admin/google-sheets';
  const state = {
    token: '',
    config: null,
    setup: null,
    connection: null,
    connecting: false,
    sequence: 0,
    timer: null,
    popup: null,
    pickerLoading: null,
  };

  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = !message;
  }
  function activity(message) {
    const item = document.createElement('li'),
      time = document.createElement('time'),
      text = document.createElement('span');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    text.textContent = message;
    item.append(time, text);
    if ($('activity').firstElementChild?.classList.contains('muted')) $('activity').replaceChildren();
    $('activity').prepend(item);
    while ($('activity').children.length > 40) $('activity').lastElementChild.remove();
  }
  async function api(path, options = {}) {
    const headers = {
      'ngrok-skip-browser-warning': '1',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    };
    if (state.token && path.startsWith(base)) headers.Authorization = `Bearer ${state.token}`;
    let response;
    try {
      response = await fetch(path, {
        ...options,
        credentials: 'include',
        cache: 'no-store',
        headers,
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new Error('Could not reach the API. Check that the backend and ngrok tunnel are running.');
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('The API returned a page instead of JSON. Check your ngrok forwarding port.');
    }
    if (!response.ok || body.success === false)
      throw new Error(body.message || body.error?.message || `Request failed (${response.status}).`);
    return body.data;
  }
  async function action(button, work) {
    button.disabled = true;
    notice('');
    try {
      await work();
    } catch (error) {
      notice(error.message || 'This check failed.', true);
      activity(error.message || 'This check failed.');
    } finally {
      render();
    }
  }
  function onCorrectHost() {
    try {
      return new URL(state.config.redirect_uri).origin === location.origin;
    } catch {
      return false;
    }
  }
  function render() {
    const signedIn = Boolean(state.token),
      connected = Boolean(state.connection?.connected);
    $('login-form').hidden = signedIn;
    $('token-details').hidden = signedIn;
    $('signed-in').hidden = !signedIn;
    $('logout').hidden = !signedIn;
    $('login-button').disabled = false;
    $('token-button').disabled = false;
    $('connect').disabled = !signedIn || !state.setup?.ready || !onCorrectHost() || state.connecting;
    $('connect').textContent = state.connecting
      ? 'Waiting for Google…'
      : connected
        ? 'Reconnect Google'
        : 'Connect Google';
    $('refresh').disabled = !signedIn;
    $('disconnect').disabled = !connected || state.connecting;
    $('pick').disabled = !connected || !state.setup?.picker?.ready;
    $('list').disabled = !connected;
    $('manual-button').disabled = !connected;
    $('spreadsheet').disabled = !connected;
    $('load-tabs').disabled = !connected || !$('spreadsheet').value;
    $('tab').disabled = !connected || !$('tab').options.length || $('tab').value === '';
    $('read-rows').disabled = !connected || $('tab').value === '';
    $('connection-badge').textContent = !signedIn ? 'Sign in first' : connected ? 'Connected' : 'Not connected';
    $('connection-badge').classList.toggle('connected', connected);
    if (state.connecting)
      $('connection-detail').textContent =
        'Complete sign-in and consent in the Google window. You can also use Check connection to stop waiting and refresh.';
    else if (connected)
      $('connection-detail').textContent =
        'Google OAuth is working. Your connection is saved for this dashboard account.';
    else
      $('connection-detail').textContent = signedIn
        ? 'Your dashboard login is ready. Connect Google to test consent and token exchange.'
        : 'Sign in to test OAuth using your app’s server configuration.';
    if (!connected) $('picker-hint').textContent = 'Connect Google to enable spreadsheet access.';
    else if (!state.setup?.picker?.ready)
      $('picker-hint').textContent =
        'OAuth is connected. To select a new file, configure GOOGLE_PICKER_API_KEY and GOOGLE_CLOUD_PROJECT_NUMBER in .env, then restart the API. You can read a previously authorized file below.';
    else
      $('picker-hint').textContent =
        'Google Picker grants this app access to the file you choose. Only authorized files appear in Refresh files.';
  }
  function showConfiguration(data) {
    state.config = data;
    const correct = onCorrectHost();
    $('configuration').className = `configuration ${data.ready && correct ? 'ready' : 'issue'}`;
    $('configuration-text').textContent = !data.ready
      ? data.issue
      : !correct
        ? 'Open this page using the callback hostname so the OAuth cookie reaches the right server.'
        : 'Application configuration is ready. Client credentials are loaded on the server.';
    $('callback').textContent = data.redirect_uri || 'Set GOOGLE_REDIRECT_URI in the backend .env file.';
    $('correct-host').hidden = correct || !data.test_url;
    if (data.test_url) {
      const target = new URL(data.test_url);
      if (
        target.protocol === 'https:' ||
        (target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))
      )
        $('correct-host').href = target.toString();
    }
    if (!$('domain').value) $('domain').value = data.login_domain || location.hostname;
    render();
  }
  function stopWaiting() {
    state.sequence++;
    clearTimeout(state.timer);
    state.timer = null;
    state.connecting = false;
  }
  async function refreshConnection(loadFiles = false) {
    state.connection = await api(`${base}/connection`);
    render();
    if (loadFiles && state.connection.connected) await listFiles();
    return state.connection;
  }
  async function signedIn(token, name) {
    state.token = token;
    try {
      state.setup = await api(`${base}/setup`);
      $('identity').textContent = name || 'Account owner signed in';
      await refreshConnection();
      activity('Dashboard login verified. Google settings are available.');
      if (!state.setup.ready) notice(state.setup.issue, true);
    } catch (error) {
      state.token = '';
      state.setup = null;
      state.connection = null;
      throw error;
    } finally {
      render();
    }
  }
  $('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action($('login-button'), async () => {
      const password = $('password').value;
      const login = await api('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: $('email').value.trim(), password, domain_name: $('domain').value.trim() }),
      });
      $('password').value = '';
      if (!login?.token) throw new Error('The login response did not contain a dashboard token.');
      await signedIn(login.token, login.data?.name || $('email').value.trim());
    });
  });
  $('token-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const token = $('jwt')
      .value.trim()
      .replace(/^Bearer\s+/i, '');
    $('jwt').value = '';
    action($('token-button'), () => signedIn(token));
  });
  $('logout').addEventListener('click', () => {
    stopWaiting();
    try {
      state.popup?.close();
    } catch {}
    state.token = '';
    state.setup = null;
    state.connection = null;
    $('password').value = '';
    $('jwt').value = '';
    $('table-wrap').hidden = true;
    $('empty-state').hidden = false;
    $('spreadsheet').replaceChildren(new Option('Choose a file first', ''));
    $('tab').replaceChildren(new Option('Select a spreadsheet', ''));
    notice('Dashboard session cleared from this page.');
    activity('Dashboard session cleared.');
    render();
  });
  $('connect').addEventListener('click', () => {
    const popup = window.open('about:blank', 'rsvpdesk-google-oauth', 'width=600,height=760');
    if (!popup) {
      notice('Allow pop-up windows for this site, then try Connect Google again.', true);
      return;
    }
    state.popup = popup;
    action($('connect'), async () => {
      stopWaiting();
      const previous = await refreshConnection();
      const previousUpdate = previous.connection?.updated_at || null;
      state.connecting = true;
      render();
      let started;
      try {
        started = await api(`${base}/oauth/start`, { method: 'POST', body: '{}' });
      } catch (error) {
        popup.close();
        state.connecting = false;
        throw error;
      }
      const target = new URL(started.authorization_url);
      if (target.origin !== 'https://accounts.google.com') {
        popup.close();
        state.connecting = false;
        throw new Error('The server returned an unexpected Google authorization URL.');
      }
      popup.location.href = target.toString();
      activity('Google authorization opened. Waiting for the callback.');
      const sequence = state.sequence,
        deadline = Date.now() + 5 * 60 * 1000;
      const poll = async () => {
        if (sequence !== state.sequence || !state.token) return;
        try {
          const result = await refreshConnection();
          if (result.connected && (!previous.connected || result.connection?.updated_at !== previousUpdate)) {
            stopWaiting();
            try {
              popup.close();
            } catch {}
            notice('Google OAuth succeeded. You can now test spreadsheet access.');
            activity('Google consent and token exchange succeeded.');
            try {
              await listFiles();
            } catch (error) {
              notice(`Google connected. ${error.message}`, true);
            }
            render();
            return;
          }
        } catch (error) {
          stopWaiting();
          notice(error.message, true);
          activity(error.message);
          render();
          return;
        }
        if (Date.now() > deadline) {
          stopWaiting();
          notice(
            'Still waiting for Google. Finish consent, then use Check connection. If Google shows an error, verify its test users and exact callback URL.',
            true,
          );
          render();
          return;
        }
        state.timer = setTimeout(poll, 2000);
      };
      state.timer = setTimeout(poll, 1500);
    });
  });
  $('refresh').addEventListener('click', () =>
    action($('refresh'), async () => {
      stopWaiting();
      state.setup = await api(`${base}/setup`);
      const result = await refreshConnection();
      activity(result.connected ? 'Google connection is active.' : 'No Google connection is saved for this account.');
      notice(result.connected ? 'Google is connected.' : 'Google is not connected yet.');
    }),
  );
  $('disconnect').addEventListener('click', () => {
    if (!window.confirm('Revoke this app’s Google connection for your dashboard account?')) return;
    action($('disconnect'), async () => {
      await api(`${base}/connection`, { method: 'DELETE' });
      state.connection = { connected: false };
      stopWaiting();
      $('table-wrap').hidden = true;
      $('empty-state').hidden = false;
      $('spreadsheet').replaceChildren(new Option('Choose a file first', ''));
      $('tab').replaceChildren(new Option('Select a spreadsheet', ''));
      notice('Google disconnected.');
      activity('Google connection revoked.');
    });
  });
  async function listFiles() {
    const result = await api(`${base}/spreadsheets`);
    const selected = $('spreadsheet').value;
    $('spreadsheet').replaceChildren(new Option('Select an authorized spreadsheet', ''));
    for (const file of result.files || []) $('spreadsheet').append(new Option(file.name || file.id, file.id));
    if ([...$('spreadsheet').options].some((option) => option.value === selected)) $('spreadsheet').value = selected;
    activity(
      `Loaded ${(result.files || []).length} authorized spreadsheet(s)${result.nextPageToken ? ' (first page)' : ''}.`,
    );
    if (!result.files?.length)
      notice('Google is connected. Choose a spreadsheet in Google Picker to grant this app file access.');
    render();
  }
  $('list').addEventListener('click', () => action($('list'), listFiles));
  function loadPickerLibrary() {
    if (state.pickerLoading) return state.pickerLoading;
    state.pickerLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(
        () => reject(new Error('Google Picker did not load. Check your network or browser extensions.')),
        20000,
      );
      script.src = 'https://apis.google.com/js/api.js';
      script.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Could not load the Google Picker library.'));
      });
      script.addEventListener('load', () =>
        window.gapi.load('picker', {
          callback: () => {
            clearTimeout(timeout);
            resolve();
          },
          onerror: () => {
            clearTimeout(timeout);
            reject(new Error('Google Picker could not start.'));
          },
        }),
      );
      document.head.append(script);
    }).catch((error) => {
      state.pickerLoading = null;
      throw error;
    });
    return state.pickerLoading;
  }
  $('pick').addEventListener('click', () =>
    action($('pick'), async () => {
      await loadPickerLibrary();
      const { access_token } = await api(`${base}/picker-token`);
      const config = state.setup.picker,
        pickerApi = window.google.picker;
      const view = new pickerApi.DocsView(pickerApi.ViewId.SPREADSHEETS)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false);
      const picker = new pickerApi.PickerBuilder()
        .addView(view)
        .setOAuthToken(access_token)
        .setDeveloperKey(config.api_key)
        .setAppId(config.app_id)
        .setOrigin(location.origin)
        .setCallback((data) => {
          if (data.action !== pickerApi.Action.PICKED) return;
          const file = data.docs?.[0];
          if (!file?.id) return;
          if (![...$('spreadsheet').options].some((option) => option.value === file.id))
            $('spreadsheet').append(new Option(file.name || file.id, file.id));
          $('spreadsheet').value = file.id;
          activity(`Selected spreadsheet: ${file.name || file.id}.`);
          action($('load-tabs'), loadTabs);
        })
        .build();
      picker.setVisible(true);
    }),
  );
  async function loadTabs() {
    const id = $('spreadsheet').value;
    if (!id) throw new Error('Select a spreadsheet first.');
    const result = await api(`${base}/spreadsheets/${encodeURIComponent(id)}/tabs`);
    $('tab').replaceChildren();
    for (const sheet of result.sheets || [])
      $('tab').append(new Option(sheet.properties.title, String(sheet.properties.sheetId)));
    if (!$('tab').options.length) $('tab').append(new Option('No tabs found', ''));
    $('table-wrap').hidden = true;
    $('empty-state').hidden = false;
    activity(`Spreadsheet access verified. Loaded ${(result.sheets || []).length} tab(s).`);
    notice('Spreadsheet access succeeded. Select a tab and read sample rows.');
    render();
  }
  $('spreadsheet').addEventListener('change', () => {
    $('tab').replaceChildren(new Option('Load tabs first', ''));
    render();
  });
  $('sheet-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action($('load-tabs'), loadTabs);
  });
  $('manual-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action($('manual-button'), async () => {
      let id = $('manual-id').value.trim();
      if (id.startsWith('https://')) {
        const url = new URL(id);
        if (url.hostname !== 'docs.google.com') throw new Error('Use a Google Sheets URL or spreadsheet ID.');
        id = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] || '';
      }
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new Error('Enter a valid spreadsheet ID or Google Sheets URL.');
      if (![...$('spreadsheet').options].some((option) => option.value === id))
        $('spreadsheet').append(new Option(id, id));
      $('spreadsheet').value = id;
      await loadTabs();
    });
  });
  $('read-rows').addEventListener('click', () =>
    action($('read-rows'), async () => {
      const id = $('spreadsheet').value,
        tab = $('tab').value;
      const result = await api(
        `${base}/spreadsheets/${encodeURIComponent(id)}/tabs/${encodeURIComponent(tab)}/preview`,
      );
      const table = $('sample-table'),
        head = table.querySelector('thead'),
        body = table.querySelector('tbody');
      head.replaceChildren();
      body.replaceChildren();
      const row = document.createElement('tr');
      for (const header of result.headers || []) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = String(header);
        row.append(cell);
      }
      head.append(row);
      for (const values of result.sample_rows || []) {
        const record = document.createElement('tr');
        for (let index = 0; index < (result.headers || []).length; index++) {
          const cell = document.createElement('td');
          cell.textContent = String(values[index] ?? '');
          record.append(cell);
        }
        body.append(record);
      }
      $('table-caption').textContent = `${result.title} · ${(result.sample_rows || []).length} sample row(s)`;
      $('table-wrap').hidden = false;
      $('empty-state').hidden = true;
      notice('Google Sheets read succeeded. Your OAuth and spreadsheet access are working.');
      activity(`Read ${(result.sample_rows || []).length} sample row(s) from ${result.title}.`);
    }),
  );
  $('clear-activity').addEventListener('click', () => $('activity').replaceChildren());
  window.addEventListener('pagehide', () => {
    stopWaiting();
    state.token = '';
  });
  api('/v1/integrations/google/test-config')
    .then(showConfiguration)
    .catch((error) => {
      $('configuration').className = 'configuration issue';
      $('configuration-text').textContent = error.message;
      notice(error.message, true);
    });
  render();
})();
