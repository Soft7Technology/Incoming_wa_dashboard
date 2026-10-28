'use strict';
(() => {
  const $ = (id) => document.getElementById(id),
    base = '/v1/admin/shopify',
    diagnostic = location.pathname.endsWith('/test');
  const state = {
    token: '',
    config: null,
    stores: [],
    busy: false,
    waiting: false,
    timer: null,
    sequence: 0,
    popup: null,
    whatsapp: null,
  };
  const selected = () => state.stores.find((s) => s.id === $('connection').value);
  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = !message;
  }
  async function api(path, method = 'GET', data) {
    const session = state.token;
    const response = await fetch(path, {
      method,
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(90000),
      headers: {
        'ngrok-skip-browser-warning': '1',
        ...(state.token && path.startsWith(base) ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('Service unavailable. Please try again.');
    }
    if (path.startsWith(base) && session !== state.token) throw new Error('Dashboard session changed. Sign in again.');
    if (!response.ok || result.success === false) throw new Error(result.message || 'This request failed.');
    return result.data;
  }
  function correctHost() {
    try {
      return new URL(state.config.redirect_uri).origin === location.origin;
    } catch {
      return false;
    }
  }
  function render() {
    const signedIn = !!state.token,
      connection = selected(),
      connected = connection?.status === 'connected';
    $('login-form').hidden = signedIn;
    $('token-details').hidden = signedIn || !diagnostic;
    $('developer-setup').hidden = !diagnostic;
    $('identity').hidden = !signedIn;
    $('logout').hidden = !signedIn;
    $('configuration').hidden = signedIn && !diagnostic && state.config?.ready && correctHost();
    $('account-heading').textContent = signedIn ? 'Your account' : 'Sign in to RSVPDesk';
    $('connect').disabled = !signedIn || !state.config?.ready || !correctHost() || state.busy || state.waiting;
    $('connect').textContent = state.waiting ? 'Waiting for Shopify...' : 'Connect Shopify';
    $('check').disabled = !signedIn || state.busy;
    $('connection').disabled = !signedIn || !state.stores.length || state.busy;
    for (const id of ['save', 'sync', 'disconnect']) $(id).disabled = !connected || state.busy || state.waiting;
    $('events-refresh').disabled = !connection || state.busy;
    $('privacy-refresh').disabled = !connection || state.busy;
    $('whatsapp-refresh').disabled = !connection || state.busy;
    for (const control of $('whatsapp-form').querySelectorAll('input, select, button'))
      control.disabled = !connected || state.busy || state.waiting;
    for (const id of ['whatsapp-sender', 'whatsapp-template']) $(id).required = $('whatsapp-enabled').checked;
    $('whatsapp-consent-confirmed').required = $('whatsapp-enabled').checked;
    for (const button of $('privacy-requests').querySelectorAll('button'))
      button.disabled = state.busy || button.dataset.unavailable === 'true';
    $('badge').textContent = connection?.status || 'No store selected';
    $('store-detail').textContent = connection
      ? `${connection.shop_domain}${connection.subscription_issue ? ' — ' + connection.subscription_issue : ''}`
      : 'Your connected stores will appear here.';
    $('connection-hint').textContent = state.waiting
      ? 'Approve access in the Shopify window, then return here. Check connections stops waiting.'
      : 'Your Shopify credentials stay on the server. Only the store domain is needed.';
    for (const checkbox of $('triggers').querySelectorAll('input')) {
      const allowed = connected && connection.scopes?.includes(checkbox.dataset.scope);
      checkbox.disabled = !allowed || state.busy || state.waiting;
    }
    for (const button of document.querySelectorAll('#login-form button, #token-form button'))
      button.disabled = state.busy;
  }
  async function action(work) {
    if (state.busy) return;
    state.busy = true;
    notice('');
    render();
    try {
      await work();
    } catch (error) {
      notice(error.message || 'Request failed. Try again.', true);
    } finally {
      state.busy = false;
      render();
    }
  }
  function stopWaiting() {
    state.sequence++;
    clearTimeout(state.timer);
    state.waiting = false;
    state.timer = null;
  }
  function resetEvents() {
    $('events').replaceChildren();
    const row = document.createElement('tr'),
      cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'No events loaded.';
    row.append(cell);
    $('events').append(row);
    $('payload').hidden = true;
    $('payload').textContent = '';
  }
  function showTriggers() {
    const connection = selected();
    for (const checkbox of $('triggers').querySelectorAll('input'))
      checkbox.checked = !!connection?.desired_topics?.includes(checkbox.value);
    resetEvents();
    $('privacy-requests').replaceChildren();
    $('privacy-summary').textContent = 'Select a store to view customer requests.';
    state.whatsapp = null;
    $('whatsapp-topic').replaceChildren();
    $('whatsapp-sender').replaceChildren();
    $('whatsapp-template').replaceChildren();
    $('whatsapp-mapping').replaceChildren();
    $('whatsapp-jobs').replaceChildren();
    $('whatsapp-enabled').checked = false;
    $('whatsapp-consent-confirmed').checked = false;
    $('whatsapp-preview').hidden = true;
    $('whatsapp-help').textContent = 'Select a store to configure order messages.';
    render();
  }
  async function loadStores(preferredShop) {
    const previous = $('connection').value;
    state.stores = (await api(`${base}/connections`)).connections || [];
    $('connection').replaceChildren(new Option('Select a connected store', ''));
    for (const store of state.stores)
      $('connection').append(new Option(`${store.name} (${store.shop_domain})`, store.id));
    const next =
      state.stores.find((s) => preferredShop && s.shop_domain === preferredShop) ||
      state.stores.find((s) => s.id === previous) ||
      state.stores[0];
    if (next) $('connection').value = next.id;
    showTriggers();
    await loadPrivacy();
    await loadWhatsApp();
    return state.stores;
  }
  async function login(token, label) {
    state.token = token;
    try {
      state.config = await api(`${base}/setup`);
      await loadStores();
      $('identity').textContent = label || 'Account owner signed in';
    } catch (error) {
      state.token = '';
      state.stores = [];
      throw error;
    }
  }
  $('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action(async () => {
      const password = $('password').value;
      $('password').value = '';
      const response = await api('/v1/auth/login', 'POST', {
        identifier: $('email').value.trim(),
        password,
        domain_name: $('domain').value.trim(),
      });
      if (!response?.token) throw new Error('The dashboard login did not return a session token.');
      await login(response.token, response.data?.name || $('email').value.trim());
    });
  });
  $('token-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const token = $('jwt')
      .value.trim()
      .replace(/^Bearer\s+/i, '');
    $('jwt').value = '';
    action(() => login(token));
  });
  $('logout').addEventListener('click', () => {
    stopWaiting();
    try {
      state.popup?.close();
    } catch {}
    state.token = '';
    state.stores = [];
    $('connection').replaceChildren(new Option('Connect a store first', ''));
    $('password').value = '';
    $('jwt').value = '';
    showTriggers();
    notice('Session cleared from this page.');
  });
  $('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || state.waiting) return;
    const popup = window.open('about:blank', 'rsvpdesk-shopify-oauth', 'width=720,height=800');
    if (!popup) return notice('Allow pop-up windows, then click Connect Shopify again.', true);
    state.popup = popup;
    action(async () => {
      const before = new Map(state.stores.map((s) => [s.shop_domain, s.updated_at]));
      try {
        const data = await api(`${base}/oauth/start`, 'POST', {
          shop: $('shop').value.trim(),
          ...($('name').value.trim() ? { name: $('name').value.trim() } : {}),
        });
        const target = new URL(data.authorization_url);
        if (
          target.protocol !== 'https:' ||
          !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(target.hostname) ||
          target.pathname !== '/admin/oauth/authorize'
        )
          throw new Error('Unexpected Shopify authorization URL.');
        stopWaiting();
        state.waiting = true;
        popup.location.href = target.toString();
        const sequence = state.sequence,
          deadline = Date.now() + 600000;
        const poll = async () => {
          if (sequence !== state.sequence || !state.token) return;
          try {
            const stores = await loadStores(target.hostname),
              connected = stores.find(
                (s) =>
                  s.shop_domain === target.hostname &&
                  s.status === 'connected' &&
                  s.updated_at !== before.get(s.shop_domain),
              );
            if (connected) {
              stopWaiting();
              try {
                popup.close();
              } catch {}
              notice(
                connected.subscription_issue || 'Store connected. Choose your triggers and click Save triggers.',
                !!connected.subscription_issue,
              );
              render();
              return;
            }
          } catch (error) {
            stopWaiting();
            notice(error.message, true);
            render();
            return;
          }
          if (Date.now() >= deadline) {
            stopWaiting();
            notice(
              'Still waiting. Complete Shopify approval, then click Check connections. If Shopify shows an error, check the app distribution and exact redirect URL.',
              true,
            );
            render();
            return;
          }
          state.timer = setTimeout(poll, 3000);
        };
        state.timer = setTimeout(poll, 2000);
      } catch (error) {
        try {
          popup.close();
        } catch {}
        stopWaiting();
        throw error;
      }
    });
  });
  $('check').addEventListener('click', () =>
    action(async () => {
      stopWaiting();
      await loadStores();
      notice('Connections refreshed.');
    }),
  );
  $('connection').addEventListener('change', () => {
    showTriggers();
    action(async () => {
      await loadPrivacy();
      await loadWhatsApp();
    });
  });
  const messagePath = (c) => `${base}/connections/${encodeURIComponent(c.id)}/whatsapp`;
  const messageRule = () => state.whatsapp?.rules.find((r) => r.topic === $('whatsapp-topic').value);
  function messageMappings() {
    const template = state.whatsapp?.templates.find((t) => t.id === $('whatsapp-template').value),
      rule = messageRule();
    $('whatsapp-mapping').replaceChildren();
    $('whatsapp-preview').hidden = !template;
    $('whatsapp-preview').textContent =
      template?.components
        ?.filter((c) => c.text)
        .map((c) => c.text)
        .join('\n') || '';
    for (const [index, key] of (template?.variables || []).entries()) {
      const wrapper = document.createElement('div'),
        label = document.createElement('label'),
        select = document.createElement('select'),
        literal = document.createElement('input');
      label.textContent = `Template variable ${key}`;
      select.id = `whatsapp-map-${index}`;
      label.htmlFor = select.id;
      select.dataset.variable = key;
      select.append(new Option('Select an order field', ''));
      for (const field of state.whatsapp.fields) select.append(new Option(field.replaceAll('_', ' '), field));
      select.append(new Option('Custom text', 'literal'));
      literal.placeholder = 'Custom text';
      literal.maxLength = 500;
      literal.hidden = true;
      literal.setAttribute('aria-label', `${key} custom text`);
      const mapping = rule?.template_id === template.id ? rule.parameter_mapping[key] : null;
      if (mapping?.field) select.value = mapping.field;
      if (mapping?.literal) {
        select.value = 'literal';
        literal.value = mapping.literal;
        literal.hidden = false;
      }
      select.addEventListener('change', () => {
        literal.hidden = select.value !== 'literal';
      });
      wrapper.append(label, select, literal);
      $('whatsapp-mapping').append(wrapper);
    }
    render();
  }
  async function messageTemplates() {
    const c = selected();
    if (!c || !state.whatsapp) return;
    const phoneId = $('whatsapp-sender').value;
    const result = phoneId
      ? await api(`${messagePath(c)}?phone_number_id=${encodeURIComponent(phoneId)}`)
      : { templates: [] };
    if (selected()?.id !== c.id) return;
    state.whatsapp.templates = result.templates;
    $('whatsapp-template').replaceChildren(new Option('Select an approved utility template', ''));
    for (const t of result.templates) {
      const option = new Option(`${t.name} (${t.language})${t.supported ? '' : ' - unsupported format'}`, t.id);
      option.disabled = !t.supported;
      $('whatsapp-template').append(option);
    }
    const rule = messageRule();
    if (rule?.phone_number_id === phoneId) $('whatsapp-template').value = rule.template_id || '';
    $('whatsapp-help').textContent = !state.whatsapp.senders.length
      ? 'Connect an active WhatsApp number in your dashboard first.'
      : !result.templates.some((t) => t.supported)
        ? 'Create or sync an approved utility text template for this sending number.'
        : 'Map template variables to the order fields you want the customer to receive.';
    messageMappings();
  }
  async function messageTopic() {
    const rule = messageRule();
    $('whatsapp-enabled').checked = !!rule?.enabled;
    $('whatsapp-consent-confirmed').checked = false;
    $('whatsapp-consent-attribute').value = rule?.consent_attribute || 'soft7_whatsapp_opt_in';
    if (rule?.phone_number_id) $('whatsapp-sender').value = rule.phone_number_id;
    await messageTemplates();
  }
  async function loadMessageJobs() {
    const c = selected();
    if (!c) return;
    const result = await api(`${messagePath(c)}/jobs`);
    if (selected()?.id !== c.id) return;
    const reasons = {
      consent_missing: 'Customer consent not recorded',
      phone_missing_or_invalid: 'Customer phone missing or not international',
      order_identity_missing: 'Order identity missing',
      contact_opted_out: 'Customer opted out',
      rule_disabled: 'Rule disabled',
      rule_changed: 'Rule changed after queueing',
      store_disconnected: 'Store disconnected',
      store_uninstalled: 'App uninstalled',
      queue_expired: 'Message expired before sending',
      customer_erased: 'Customer data erased',
      configuration_or_order_fields_unavailable: 'Check the sending number, template and mapped order fields',
      send_outcome_unconfirmed: 'Check WhatsApp history before taking further action',
    };
    $('whatsapp-jobs').replaceChildren();
    for (const job of result.jobs) {
      const row = document.createElement('tr');
      for (const text of [
        new Date(job.created_at).toLocaleString(),
        job.topic,
        job.resource_id || '-',
        job.status,
        reasons[job.reason] || (job.status === 'queued' ? 'Waiting for message worker' : ''),
      ]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      $('whatsapp-jobs').append(row);
    }
  }
  async function loadWhatsApp() {
    const c = selected();
    if (!c) return;
    const data = await api(messagePath(c));
    if (selected()?.id !== c.id) return;
    state.whatsapp = data;
    $('whatsapp-topic').replaceChildren(
      ...data.topics.map((t) => new Option(state.config.triggers.find((v) => v.topic === t)?.label || t, t)),
    );
    $('whatsapp-sender').replaceChildren(
      new Option('Select a WhatsApp number', ''),
      ...data.senders.map((p) => new Option(p.display_phone_number || p.id, p.id)),
    );
    await messageTopic();
    await loadMessageJobs();
  }
  $('whatsapp-topic').addEventListener('change', () => action(messageTopic));
  $('whatsapp-sender').addEventListener('change', () => action(messageTemplates));
  $('whatsapp-template').addEventListener('change', messageMappings);
  $('whatsapp-enabled').addEventListener('change', render);
  $('whatsapp-refresh').addEventListener('click', () => action(loadMessageJobs));
  $('whatsapp-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action(async () => {
      const c = selected();
      if (!c) return;
      const mapping = {};
      for (const select of $('whatsapp-mapping').querySelectorAll('select')) {
        if (select.value === 'literal') mapping[select.dataset.variable] = { literal: select.nextElementSibling.value };
        else mapping[select.dataset.variable] = { field: select.value };
      }
      const topic = $('whatsapp-topic').value;
      const data = {
        topic,
        enabled: $('whatsapp-enabled').checked,
        phone_number_id: $('whatsapp-sender').value,
        template_id: $('whatsapp-template').value,
        parameter_mapping: mapping,
        consent_attribute: $('whatsapp-consent-attribute').value,
        consent_confirmed: $('whatsapp-consent-confirmed').checked,
      };
      await api(`${messagePath(c)}/rule`, 'PUT', data);
      await loadWhatsApp();
      $('whatsapp-topic').value = topic;
      await messageTopic();
      notice(data.enabled ? 'Message rule enabled for future eligible order events.' : 'Message rule disabled.');
    });
  });
  async function loadPrivacy() {
    const c = selected();
    if (!c) return;
    const result = await api(`${base}/connections/${encodeURIComponent(c.id)}/privacy-requests`);
    if (selected()?.id !== c.id) return;
    $('privacy-summary').textContent =
      `${result.pending} pending request(s); ${result.overdue} overdue. ${result.overdue ? 'Overdue requests need immediate attention.' : 'Check this list regularly.'}`;
    $('privacy-summary').classList.toggle('danger', result.overdue > 0);
    $('privacy-requests').replaceChildren();
    for (const request of result.requests) {
      const row = document.createElement('tr');
      for (const text of [
        new Date(request.created_at).toLocaleString(),
        request.topic === 'customers/data_request' ? 'Access / export' : 'Erasure',
        new Date(request.due_at).toLocaleDateString(),
        request.status,
      ]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      const cell = document.createElement('td');
      row.append(cell);
      if (request.topic === 'customers/data_request' && request.status === 'pending') {
        const download = document.createElement('button');
        download.textContent = 'Download export';
        download.addEventListener('click', () =>
          action(async () => {
            const path = `${base}/connections/${encodeURIComponent(c.id)}/privacy-requests/${encodeURIComponent(request.id)}`;
            let cursor = '',
              section = 'events',
              more = true,
              first,
              events = [],
              messages = [];
            do {
              const page = await api(
                `${path}/export?section=${section}${cursor ? '&after=' + encodeURIComponent(cursor) : ''}`,
              );
              first ||= page;
              events.push(...page.events);
              messages.push(...(page.messages || []));
              cursor = page.next_cursor;
              more = !!cursor;
              if (!cursor && page.next_section) {
                section = page.next_section;
                more = true;
              }
            } while (more);
            const blob = new Blob(
              [
                JSON.stringify(
                  {
                    request_id: first.request_id,
                    shop_domain: first.shop_domain,
                    request: first.request,
                    events,
                    messages,
                  },
                  null,
                  2,
                ),
              ],
              { type: 'application/json' },
            );
            const url = URL.createObjectURL(blob),
              link = document.createElement('a');
            link.href = url;
            link.download = `shopify-data-request-${request.id}.json`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            await loadPrivacy();
            notice('Export downloaded. Deliver it securely to the merchant, then confirm delivery here.');
          }),
        );
        const complete = document.createElement('button');
        complete.textContent = 'Confirm delivered';
        complete.dataset.unavailable = String(!request.exported_at);
        complete.addEventListener('click', () => {
          if (
            !window.confirm(
              'Have you delivered the complete customer data export to the merchant through a secure channel?',
            )
          )
            return;
          action(async () => {
            await api(
              `${base}/connections/${encodeURIComponent(c.id)}/privacy-requests/${encodeURIComponent(request.id)}/complete`,
              'POST',
              { delivered: true },
            );
            await loadPrivacy();
            notice('Delivery recorded. This request is complete.');
          });
        });
        cell.append(download, complete);
      }
      $('privacy-requests').append(row);
    }
    render();
  }
  $('privacy-refresh').addEventListener('click', () => action(loadPrivacy));
  $('trigger-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action(async () => {
      const connection = selected();
      if (!connection) throw new Error('Select a store first.');
      // action() disables controls during a request; read checked values using granted scopes instead.
      const selectedTopics = [...$('triggers').querySelectorAll('input:checked')]
        .filter((input) => connection.scopes.includes(input.dataset.scope))
        .map((input) => input.value);
      await api(`${base}/connections/${encodeURIComponent(connection.id)}/triggers`, 'PUT', { topics: selectedTopics });
      await loadStores(connection.shop_domain);
      notice('Triggers saved. Make a matching change in Shopify, then refresh the event inbox.');
    });
  });
  $('sync').addEventListener('click', () =>
    action(async () => {
      const c = selected();
      if (!c) return;
      await api(`${base}/connections/${encodeURIComponent(c.id)}/sync`, 'POST', {});
      await loadStores(c.shop_domain);
      notice('Webhook subscriptions synchronized.');
    }),
  );
  $('disconnect').addEventListener('click', () => {
    if (!window.confirm('Disconnect this store and stop its event subscriptions?')) return;
    action(async () => {
      const c = selected();
      if (!c) return;
      await api(`${base}/connections/${encodeURIComponent(c.id)}`, 'DELETE');
      await loadStores(c.shop_domain);
      notice('Store disconnected. The Shopify app remains installed until you uninstall it in Shopify.');
    });
  });
  $('events-refresh').addEventListener('click', () =>
    action(async () => {
      const c = selected();
      if (!c) return;
      const result = await api(`${base}/connections/${encodeURIComponent(c.id)}/events`);
      resetEvents();
      if (!result.events?.length)
        return notice('No events yet. Save triggers and create a matching event in this Shopify store.');
      $('events').replaceChildren();
      for (const event of result.events) {
        const row = document.createElement('tr');
        for (const value of [
          new Date(event.received_at).toLocaleString(),
          event.topic,
          event.resource_id || '-',
          event.status,
        ]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        const cell = document.createElement('td'),
          button = document.createElement('button');
        button.textContent = 'View';
        button.addEventListener('click', () =>
          action(async () => {
            const data = await api(
              `${base}/connections/${encodeURIComponent(c.id)}/events/${encodeURIComponent(event.id)}`,
            );
            $('payload').textContent = JSON.stringify(data, null, 2);
            $('payload').hidden = false;
          }),
        );
        cell.append(button);
        row.append(cell);
        $('events').append(row);
      }
    }),
  );
  window.addEventListener('pagehide', stopWaiting);
  (async () => {
    try {
      state.config = await api('/v1/integrations/shopify/test-config');
      $('callback').textContent = state.config.redirect_uri || 'Set SHOPIFY_REDIRECT_URI in the backend.';
      $('domain').value = state.config.login_domain || location.hostname;
      $('retention-notice').textContent =
        `Event data is retained for up to ${state.config.retention_days} days, with a hold for outstanding privacy requests.`;
      const correct = correctHost();
      $('configuration').classList.toggle('error', !state.config.ready || !correct);
      $('configuration').textContent = !state.config.ready
        ? diagnostic
          ? state.config.issue
          : 'The store connection is temporarily unavailable. Contact support.'
        : !correct
          ? `Open the store connection page at ${state.config.app_url}`
          : 'App configuration is ready. Sign in to connect a store.';
      for (const trigger of state.config.triggers) {
        const label = document.createElement('label'),
          checkbox = document.createElement('input'),
          text = document.createElement('span'),
          hint = document.createElement('small');
        label.className = 'trigger';
        checkbox.type = 'checkbox';
        checkbox.value = trigger.topic;
        checkbox.dataset.scope = trigger.required_scope;
        text.textContent = trigger.label;
        hint.textContent = trigger.topic;
        hint.hidden = !diagnostic;
        text.append(hint);
        label.append(checkbox, text);
        $('triggers').append(label);
      }
    } catch (error) {
      notice(error.message, true);
    }
    render();
  })();
})();
