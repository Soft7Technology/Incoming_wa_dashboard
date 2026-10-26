'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const base = '/v1/facebook/api/ads';
  let busy = false, accountVersion = 0, businessVersion = 0, requestId = null, requestKey = null;
  const notice = message => { $('notice').textContent = message; $('notice').hidden = !message; };
  async function api(path, method = 'GET', body) {
    const response = await window.metaWorkspace.fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || 'The request failed.');
    return result.data;
  }
  async function run(fn) {
    if (busy) return;
    busy = true; notice('');
    const buttons = [...document.querySelectorAll('button, select, input')];
    const previous = buttons.map(node => node.disabled);
    buttons.forEach(node => { node.disabled = true; });
    try { await fn(); } catch (error) { notice(error.message); }
    finally { buttons.forEach((node, i) => { node.disabled = previous[i]; }); busy = false; }
  }
  function option(select, value, name) {
    const node = document.createElement('option'); node.value = value; node.textContent = name; select.append(node);
  }
  function clearReports() {
    accountVersion++; $('reporting').hidden = true; $('creation').hidden = true;
    $('metrics').replaceChildren(); $('campaigns').replaceChildren(); $('create-status').textContent = '';
    $('confirm-create').checked = false;
  }
  const path = () => '/businesses/' + encodeURIComponent($('business').value) + '/accounts/' + encodeURIComponent($('account').value);
  async function businesses() {
    clearReports(); businessVersion++; $('business').replaceChildren(); $('account').replaceChildren();
    const rows = await api('/businesses');
    option($('business'), '', 'Select a business portfolio');
    rows.forEach(row => option($('business'), row.id, row.name + ' (' + row.id + ')'));
    $('asset-status').textContent = rows.length ? 'Select a business to load its owned and client ad accounts.' : 'No business portfolios returned. Check your business role and assets selected in Facebook.';
    $('selection').hidden = false;
  }
  async function accounts() {
    clearReports(); const version = ++businessVersion; $('account').replaceChildren();
    if (!$('business').value) return;
    const rows = await api('/businesses/' + encodeURIComponent($('business').value) + '/accounts');
    if (version !== businessVersion) return;
    option($('account'), '', 'Select an ad account');
    rows.forEach(row => option($('account'), row.id, row.name + ' (' + row.id + ') · ' + row.currency));
    $('asset-status').textContent = rows.length ? rows.length + ' authorized ad account(s).' : 'No ad accounts in this business were returned. Check the assets and tasks granted in Facebook.';
  }
  function card(container, title, value) {
    const node = document.createElement('div'); node.className = 'card';
    const heading = document.createElement('strong'); heading.textContent = title;
    const text = document.createElement('p'); text.textContent = value; node.append(heading, text); container.append(node);
  }
  async function reports() {
    if (!$('account').value) { clearReports(); return; }
    const version = ++accountVersion, selected = path();
    $('reporting').hidden = false; $('creation').hidden = false;
    $('metrics').replaceChildren(); $('campaigns').replaceChildren(); $('report-status').textContent = 'Loading Meta data…';
    const results = await Promise.allSettled([api(selected + '/insights?period=' + $('period').value), api(selected + '/campaigns')]);
    if (version !== accountVersion) return;
    const [insights, campaigns] = results;
    if (insights.status === 'fulfilled') {
      const row = insights.value.rows[0];
      $('report-status').textContent = row ? `Meta reporting period: ${row.date_start} to ${row.date_stop}. Spend is in the ad account currency.` : 'Meta returned no delivery data for this period. Select another period or an account with historical activity.';
      if (row) {
        [['Spend', row.spend], ['Impressions', row.impressions], ['Reach', row.reach], ['Clicks', row.clicks]].forEach(([label, value]) => card($('metrics'), label, value ?? 'Not returned'));
        (row.actions || []).forEach(action => card($('metrics'), 'Action: ' + action.action_type, action.value));
        if (!row.actions?.length) card($('metrics'), 'Conversions / actions', 'Meta returned no attributed actions for this period.');
      }
    } else $('report-status').textContent = insights.reason.message;
    if (campaigns.status === 'fulfilled') {
      if (!campaigns.value.length) $('campaigns').textContent = 'No campaigns returned for this ad account.';
      campaigns.value.forEach(row => card($('campaigns'), row.name, `${row.id} · ${row.status} · ${row.objective}`));
    } else $('campaigns').textContent = campaigns.reason.message;
  }
  $('connect').onclick = () => run(async () => {
    const result = await api('/oauth/start', 'POST', {});
    const url = new URL(result.authorization_url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com') throw new Error('Invalid Facebook login URL.');
    location.assign(url.href);
  });
  $('disconnect').onclick = () => run(async () => {
    await api('/disconnect', 'POST', {}); location.assign('/v1/facebook/ads');
  });
  $('reload-businesses').onclick = () => run(businesses);
  $('business').onchange = () => run(accounts);
  $('account').onchange = () => run(async () => { clearReports(); await reports(); });
  $('period').onchange = () => run(reports);
  $('refresh').onclick = () => run(reports);
  $('campaign-form').onsubmit = event => {
    event.preventDefault();
    if (!$('confirm-create').checked) return;
    return run(async () => {
      const name = $('campaign-name').value.trim(), key = JSON.stringify({ path: path(), name });
      if (!requestId || requestKey !== key) { requestId = crypto.randomUUID(); requestKey = key; }
      $('create-status').textContent = 'Creating paused campaign…';
      const result = await api(path() + '/campaigns', 'POST', { name, client_request_id: requestId });
      if (result.status === 'confirmed') {
        $('create-status').textContent = 'Paused campaign created. Meta campaign ID: ' + result.campaign_id;
        $('confirm-create').checked = false;
      } else if (result.status === 'unconfirmed') {
        $('create-status').textContent = 'Meta did not confirm creation. Check the campaign list or Ads Manager before creating another campaign. Repeating this request will not resend it.';
      } else $('create-status').textContent = 'Meta rejected creation. Check the ad account role, ads_management grant, API version and Marketing API access level. Use a new name after resolving the issue.';
      await reports();
    });
  };
  run(async () => {
    await window.metaWorkspace.ready(); $('workspace').hidden = false;
    const setup = await api('/setup');
    $('configuration').hidden = !setup.issue; $('configuration').textContent = setup.issue || '';
    const status = await api('/status');
    $('disconnect').hidden = !status.connected;
    $('connection-status').textContent = status.connected ? 'Facebook connected. Granted: ' + status.permissions.join(', ') : 'Facebook is not connected.';
    if (status.error) notice(status.error);
    if (status.connected) await businesses();
  });
})();
