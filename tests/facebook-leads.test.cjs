const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { load, fixture, utils, leadMigration } = require('./facebook-helpers.cjs');

const dbTest = (name, run) => test(name, { skip: !process.env.FACEBOOK_TEST_DATABASE_URL && 'Set FACEBOOK_TEST_DATABASE_URL to isolated local PostgreSQL.' }, () => leadFixture(run));

async function leadFixture(run) {
  await fixture(async (context) => {
    const { meta, leadService, a } = context;
    meta.grants = [...utils.leadPermissions];
    let fields = [], leadCalls = 0;
    const original = meta.call.bind(meta);
    const lead = (id = '60001', value = 'Ada Example') => ({ id, form_id: '50001', created_time: '2026-10-14T10:00:00Z', field_data: [
      { name: 'full_name', values: [value] }, { name: 'email', values: ['ada@example.test'] }, { name: 'phone_number', values: ['+919876543210'] },
    ] });
    meta.call = async (path, token, method = 'GET', params = {}, body) => {
      meta.calls.push({ path, token, method, params, body });
      if (meta.failure) throw meta.failure;
      if (path === '20001') return { id: '20001', name: 'Live Page Name' };
      if (path.endsWith('/subscribed_apps')) {
        if (method === 'POST') fields = body.subscribed_fields.split(',');
        if (method === 'DELETE') fields = [];
        return method === 'GET' ? { data: [{ id: process.env.FACEBOOK_APP_ID, subscribed_fields: fields }] } : { success: true };
      }
      if (path === '20001/leadgen_forms') return { data: [{ id: '50001', name: 'Request a quote', status: 'ACTIVE', questions: [{ key: 'email', label: 'Email address', type: 'EMAIL' }] }] };
      if (path === '50001/leads') {
        leadCalls++;
        return params.after ? { data: [lead('60002')] } : { data: [lead()], paging: { next: 'https://evil.example/leak', cursors: { after: 'page-two' } } };
      }
      if (/^600\d+$/.test(path)) return lead(path);
      meta.calls.pop(); return original(path, token, method, params, body);
    };
    async function connectLead(account = a) {
      const login = await leadService.start(account);
      const state = new URL(login.url).searchParams.get('state');
      assert.equal(await leadService.callback(state, login.browser, 'fixture-code', false), 'ready');
      return leadService.connect(account, login.browser, '20001');
    }
    async function ready() {
      const page = await connectLead();
      const form = (await leadService.forms(a, page.id)).forms[0];
      await leadService.enable(a, form.id, true);
      return { page, form };
    }
    const webhook = (id = '60003') => ({ object: 'page', entry: [{ id: '20001', changes: [{ field: 'leadgen', value: { page_id: '20001', form_id: '50001', leadgen_id: id } }] }] });
    await run({ ...context, connectLead, ready, lead, webhook, fields: () => fields, leadCalls: () => leadCalls });
  });
}

test('lead Page discovery accepts Pages without Messenger tasks, but requires a Page token', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph();
  graph.call = async () => ({ data: [{ id: '20001', access_token: 'TEST_TOKEN', tasks: ['ADVERTISE'] }, { id: '20002', tasks: ['MANAGE'] }] });
  assert.deepEqual(Array.from(await graph.pages('TOKEN', 'leads'), (p) => p.id), ['20001']);
  await assert.rejects(graph.pages('TOKEN'), /messaging access/);
});

test('lead authorization uses its own callback and validates user token grants', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph(), calls = [];
  graph.call = async (path, _token, _method, params) => {
    calls.push({ path, params });
    if (path === 'oauth/access_token') return { access_token: 'TEST_USER' };
    if (path === 'debug_token') return { data: { is_valid: true, app_id: process.env.FACEBOOK_APP_ID, type: 'USER', user_id: '30001' } };
    return { data: utils.leadPermissions.map(permission => ({ permission, status: 'granted' })) };
  };
  const callback = 'https://support.example.test/v1/facebook/leads/oauth/callback';
  assert.equal((await graph.authorize('CODE', callback)).userId, '30001');
  assert.equal(calls[0].params.redirect_uri, callback);
  delete process.env.FACEBOOK_LOGIN_CONFIG_ID;
  assert.doesNotThrow(() => utils.config('leads'));
  process.env.FACEBOOK_LOGIN_CONFIG_ID = '10002';
});

test('pasted token validation rejects foreign-app, Page, system-user and expired tokens without echoing credentials', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph(), token = 'PRIVATE_USER_TOKEN_DO_NOT_ECHO';
  const valid = { is_valid: true, app_id: process.env.FACEBOOK_APP_ID, type: 'USER', user_id: '30001', expires_at: 0, data_access_expires_at: Math.floor(Date.now() / 1000) + 3600 };
  for (const data of [
    { ...valid, is_valid: false }, { ...valid, app_id: 'another-app' }, { ...valid, type: 'PAGE' },
    { ...valid, type: 'SYSTEM_USER' }, { ...valid, expires_at: 1 }, { ...valid, data_access_expires_at: 1 },
  ]) {
    graph.call = async () => ({ data });
    await assert.rejects(graph.inspectUser(token), error => !error.message.includes(token));
  }
  graph.call = async path => path === 'debug_token' ? { data: valid } : { data: [
    { permission: 'leads_retrieval', status: 'granted' }, { permission: 'pages_manage_ads', status: 'declined' },
  ] };
  const auth = await graph.inspectUser(token);
  assert.equal(auth.userId, '30001'); assert.deepEqual(Array.from(auth.granted), ['leads_retrieval']);
  assert.equal(auth.token, token);
});

dbTest('token import works without a Login configuration, checks grants and never stores or exposes the user token', async ({ leadService, a, b, member, meta, database }) => {
  const value = 'PRIVATE_TEST_FACEBOOK_USER_TOKEN';
  delete process.env.FACEBOOK_LEADS_LOGIN_CONFIG_ID;
  try {
    await assert.rejects(leadService.importToken(member, value), /account owner/);
    for (const invalid of [null, ['token'], '', 'bad token', 'x'.repeat(8193)]) await assert.rejects(leadService.importToken(a, invalid));
    meta.grants = ['pages_show_list'];
    await assert.rejects(leadService.importToken(a, value), error => error.code === 'MISSING_PERMISSIONS' && !error.message.includes(value));
    meta.grants = [...utils.leadPermissions];
    const imported = await leadService.importToken(a, value);
    assert.equal(imported.token, undefined);
    const session = await database('facebook_lead_oauth_sessions').first();
    assert.equal(JSON.stringify(session).includes(value), false);
    assert.equal(utils.decrypt(session.candidates_ciphertext).includes(value), false);
    assert.equal(JSON.stringify(await leadService.candidates(a, imported.browser)).includes('TEST_PAGE_TOKEN'), false);
    assert.equal((await leadService.candidates(b, imported.browser)).pages.length, 0);
    await assert.rejects(leadService.connect(a, 'wrong-browser', '20001'), /expired/);
    const page = await leadService.connect(a, imported.browser, '20001');
    assert.equal(page.status, 'connected');
    assert.equal((await database('facebook_lead_oauth_sessions').first()).candidates_ciphertext, null);
    await assert.rejects(leadService.connect(a, imported.browser, '20001'), /expired/);
  } finally { process.env.FACEBOOK_LEADS_LOGIN_CONFIG_ID = '10003'; }
});

dbTest('lead connection detects revoked Messenger grants and subscribes only to permitted lead fields', async ({ leadService, service, connect, connectLead, a, meta, fields, database }) => {
  meta.grants = [...utils.permissions]; await connect();
  meta.grants = [...utils.leadPermissions];
  meta.inspectPage = async () => ({ expires: null, granted: [...utils.leadPermissions] });
  const lead = await connectLead(); assert.equal(lead.status, 'connected');
  assert.deepEqual(fields(), ['leadgen']);
  const messenger = await database('facebook_pages').first();
  assert.equal(messenger.status, 'reconnect_required'); assert.match(messenger.error, /pages_messaging/);
  assert.equal((await service.pages(a))[0].status, 'reconnect_required');
});

dbTest('lead connection preserves a working Messenger subscription when no token grants both features', async ({ connect, connectLead, meta, fields, database }) => {
  meta.grants = [...utils.permissions]; await connect();
  meta.grants = [...utils.leadPermissions]; let inspected = 0;
  meta.inspectPage = async () => ({ expires: null, granted: ++inspected === 1 ? [...utils.leadPermissions] : [...utils.permissions] });
  const page = await connectLead(); assert.equal(page.status, 'subscription_failed'); assert.match(page.error, /both pages_messaging/);
  assert.deepEqual(fields(), Array.from(utils.subscriptions));
  assert.equal((await database('facebook_pages').first()).status, 'connected');
});

dbTest('lead consent is browser-bound, single-use, tenant-scoped and checks the exact required grants', async ({ leadService, a, b, member, meta, database }) => {
  await assert.rejects(leadService.start(member), /account owner/);
  const login = await leadService.start(a), url = new URL(login.url), state = url.searchParams.get('state');
  assert.equal(url.searchParams.get('config_id'), '10003');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://support.example.test/v1/facebook/leads/oauth/callback');
  await assert.rejects(leadService.callback(state, 'wrong-browser', 'code', false));
  assert.equal(await leadService.callback(state, login.browser, 'code', false), 'ready');
  await assert.rejects(leadService.callback(state, login.browser, 'code', false));
  assert.equal((await leadService.candidates(b, login.browser)).pages.length, 0);
  assert.equal(JSON.stringify(await leadService.candidates(a, login.browser)).includes('TEST_PAGE_TOKEN'), false);
  const next = await leadService.start(a); meta.grants = ['pages_show_list'];
  assert.equal(await leadService.callback(new URL(next.url).searchParams.get('state'), next.browser, 'code', false), 'failed');
  assert.match((await leadService.candidates(a, next.browser)).error, /leads_retrieval/);
  assert.equal((await database('facebook_lead_pages')).length, 0);
  process.env.FACEBOOK_LOGIN_MODE = 'classic';
  try { assert.equal(new URL((await leadService.start(a)).url).searchParams.get('scope'), utils.leadPermissions.join(',')); }
  finally { process.env.FACEBOOK_LOGIN_MODE = 'business'; }
});

dbTest('lead connection reads real Page metadata, encrypts tokens, verifies webhooks and rejects transfers', async ({ leadService, connectLead, a, b, other, meta, database }) => {
  const page = await connectLead();
  assert.equal(page.name, 'Live Page Name'); assert.equal(page.status, 'connected'); assert.equal(page.token_ciphertext, undefined);
  const saved = await database('facebook_lead_pages').first(); assert.equal(utils.decrypt(saved.token_ciphertext), 'TEST_PAGE_TOKEN');
  assert.notEqual(saved.token_ciphertext, 'TEST_PAGE_TOKEN');
  assert.ok(meta.calls.some(call => call.path === '20001' && call.params.fields === 'id,name'));
  await assert.rejects(connectLead(b), /another account/); await assert.rejects(connectLead(other), /another account/);
  assert.equal((await leadService.pages(b)).length, 0);
  meta.failure = new utils.FacebookError(403, 'Missing access', 'PERMISSION_DENIED');
  await assert.rejects(leadService.forms(a, page.id), /Missing access/);
});

dbTest('form import preserves selection; paged syncing skips duplicates and isolates owners and companies', async ({ leadService, ready, a, b, other, database, meta, leadCalls }) => {
  const { page, form } = await ready();
  assert.equal((await leadService.forms(a, page.id)).forms[0].enabled, true);
  assert.equal((await leadService.sync(a, form.id)).next_cursor, 'page-two');
  assert.equal((await leadService.sync(a, form.id, 'page-two')).imported, 1);
  assert.equal((await leadService.sync(a, form.id)).imported, 0);
  assert.equal((await leadService.leads(a, form.id)).leads.length, 2);
  assert.ok(meta.calls.filter(c => c.path === '50001/leads').every(c => c.token === 'TEST_PAGE_TOKEN'));
  for (const account of [b, other]) {
    await assert.rejects(leadService.forms(account, page.id), /not found/);
    await assert.rejects(leadService.leads(account, form.id), /not found/);
    await assert.rejects(leadService.sync(account, form.id), /not found/);
    await assert.rejects(leadService.enable(account, form.id, true), /not found/);
  }
  await leadService.enable(a, form.id, false); const calls = leadCalls();
  await assert.rejects(leadService.sync(a, form.id), /Enable syncing/); assert.equal(leadCalls(), calls);
  assert.equal((await database('facebook_leads')).length, 2);
});

dbTest('webhooks fetch lead answers, deduplicate concurrent delivery and reject foreign or disabled forms', async ({ leadService, ready, a, database, webhook, meta }) => {
  const { form } = await ready();
  await Promise.all([leadService.receive(webhook()), leadService.receive(webhook()), leadService.receive(webhook())]);
  assert.equal((await database('facebook_leads')).length, 1);
  const foreign = webhook('60004'); foreign.entry[0].changes[0].value.page_id = '20002'; await leadService.receive(foreign);
  const otherForm = webhook('60004'); otherForm.entry[0].changes[0].value.form_id = '50002'; await leadService.receive(otherForm);
  assert.equal((await database('facebook_leads')).length, 1);
  const calls = meta.calls.length; await leadService.receive(webhook()); assert.equal(meta.calls.length, calls);
  await leadService.enable(a, form.id, false); await leadService.receive(webhook('60005'));
  assert.equal((await database('facebook_leads')).length, 1);
  await leadService.enable(a, form.id, true);
  meta.failure = new utils.FacebookError(403, 'Lead access denied', 'PERMISSION_DENIED');
  await assert.rejects(leadService.receive(webhook('60006')), error => error.status === 503);
  assert.match((await database('facebook_lead_forms').first()).sync_error, /Lead access denied/);
  meta.failure = null; await leadService.receive(webhook('60006'));
  assert.equal((await database('facebook_leads')).length, 2);
  assert.equal((await database('facebook_lead_forms').first()).sync_error, null);
});

dbTest('disconnect during a remote fetch blocks persistence and deletion erases form and lead data', async ({ leadService, ready, a, database, webhook, meta }) => {
  const { page, form } = await ready();
  const original = meta.call.bind(meta);
  meta.call = async (...args) => {
    const result = await original(...args);
    if (args[0] === '50001/leads') await leadService.disconnect(a, page.id);
    return result;
  };
  await assert.rejects(leadService.sync(a, form.id), /not connected/);
  assert.equal((await database('facebook_leads')).length, 0);
  await leadService.receive(webhook()); assert.equal((await database('facebook_leads')).length, 0);
  assert.equal((await database('facebook_lead_pages').first()).token_ciphertext, null);
  await leadService.disconnect(a, page.id, true);
  assert.equal((await database('facebook_lead_forms')).length, 0);
});

dbTest('Messenger and lead subscriptions survive either connection order and individual disconnects', async ({ leadService, service, connectLead, connect, a, b, meta, fields }) => {
  const leadPage = await connectLead();
  meta.grants = [...utils.permissions];
  const messenger = await connect();
  assert.ok(fields().includes('leadgen')); assert.ok(fields().includes('messages'));
  await leadService.disconnect(a, leadPage.id);
  assert.ok(fields().includes('messages')); assert.equal(fields().includes('leadgen'), false);
  meta.grants = [...utils.leadPermissions]; await connectLead();
  assert.ok(fields().includes('leadgen')); assert.ok(fields().includes('messages'));
  await service.disconnect(a, messenger.id);
  assert.deepEqual(fields(), ['leadgen']);
  meta.grants = [...utils.permissions]; await assert.rejects(connect(b), /another account/);
});

dbTest('signed lifecycle revocation and erasure work for suspended owners and migration rolls back', async ({ leadService, ready, database, webhook, a }) => {
  await ready(); await leadService.receive(webhook());
  await database('users').where({ id: a.ownerId }).update({ status: 'suspended' });
  await leadService.revoke('30001', false);
  assert.equal((await database('facebook_lead_pages').first()).token_ciphertext, null);
  assert.equal((await database('facebook_leads')).length, 1);
  await leadService.revoke('30001', true);
  assert.equal((await database('facebook_leads')).length, 0); assert.equal((await database('facebook_lead_forms')).length, 0);
  await leadMigration.down(database); assert.equal(await database.schema.hasTable('facebook_lead_pages'), false);
});

dbTest('revocation retains the other integration when a different Facebook person authorized it', async ({ leadService, service, connectLead, connect, a, database, meta, fields }) => {
  await connectLead(); meta.grants = [...utils.permissions]; await connect();
  await database('facebook_pages').update({ facebook_user_id: '30002' });
  await leadService.revoke('30001', false);
  assert.ok(fields().includes('messages')); assert.equal(fields().includes('leadgen'), false);
  assert.equal((await database('facebook_pages').first()).status, 'connected');
  meta.grants = [...utils.leadPermissions]; await connectLead();
  await service.revoke('30002', false);
  assert.deepEqual(fields(), ['leadgen']);
  assert.equal((await database('facebook_lead_pages').first()).status, 'connected');
});

function controllers(service, leadService, instagramService = { receive: async () => {}, revoke: async () => {} }) {
  const messenger = load('src/app/http/controllers/facebookMessenger.controller.ts', {
    '../../services/instagram.service': { __esModule: true, default: instagramService },
    '../../services/facebookMessenger.service': { __esModule: true, default: service },
    '../../services/facebookLeads.service': { __esModule: true, default: leadService }, '../../utils/facebook': utils,
  });
  const leads = load('src/app/http/controllers/facebookLeads.controller.ts', {
    '../../services/facebookLeads.service': { __esModule: true, default: leadService },
    './facebookMessenger.controller': messenger, '../../utils/facebook': utils,
  });
  return { messenger, leads };
}

dbTest('real HTTP routes require JWT, bind OAuth cookies, verify raw webhook signatures and delete lead data', async ({ service, leadService, a, b, meta, database, ready, webhook }) => {
  const { messenger, leads } = controllers(service, leadService);
  const app = express(); app.use(express.json({ verify: (req, _res, body) => { req.rawBody = body; } }));
  class Unauthorized extends Error { constructor(data) { super(data.message); this.status = 401; } }
  const auth = load('library/surefy/src/middleware/jwtAuth.middleware.ts', {
    '../utils/facebookReviewSession': load('library/surefy/src/utils/facebookReviewSession.ts'), '../database': database, '../exceptions/HTTP401Error': Unauthorized,
  }).jwtAuthMiddleware;
  const deps = { '../app/http/controllers/facebookMessenger.controller': messenger, '../app/http/controllers/facebookAds.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } },
    '../app/http/controllers/facebookLeads.controller': leads,
    '../app/http/controllers/facebookContent.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } }, '../app/http/controllers/instagram.controller': { __esModule: true, default: Object.fromEntries(['callback', 'verify', 'receive', 'deauthorize', 'deletion', 'publishingMedia'].map(key => [key, (_req, res) => res.sendStatus(400)])) } };
  app.use('/v1/admin/facebook-leads', auth, load('src/routes/facebookLeads.route.ts', deps).default);
  deps['./facebookLoginTest.route'] = express.Router();
  deps['./facebookReviewLogin.route'] = express.Router();
  deps['./publicMetaWorkspace.route'] = express.Router();
  app.use('/v1/facebook', load('src/routes/facebookPublic.route.ts', deps).default);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const bearer = scope => ({ Authorization: 'Bearer ' + jwt.sign({ userId: scope.userId, ownerId: scope.ownerId, role: 'company' }, process.env.JWT_SECRET) });
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/v1/admin/facebook-leads/pages')).status, 401);
    assert.equal((await post('/v1/admin/facebook-leads/preset/pages', {}, bearer(a))).status, 404);
    assert.equal((await post('/v1/admin/facebook-leads/token', {}, bearer(a))).status, 404);
    let response = await post('/v1/admin/facebook-leads/oauth/start', {}, bearer(a));
    const cookie = response.headers.get('set-cookie').split(';')[0], login = (await response.json()).data;
    assert.match(cookie, /^fb_lead_browser=/); const state = new URL(login.authorization_url).searchParams.get('state');
    response = await fetch(base + '/v1/facebook/leads/oauth/callback?state=' + state + '&code=test', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), utils.frontendCallback('leads', 'ready'));
    response = await post('/v1/admin/facebook-leads/pages', { page_id: '20001' }, { ...bearer(a), Cookie: cookie });
    assert.equal(response.status, 200); assert.equal((await response.json()).data.status, 'connected');
    const { form } = await ready();
    response = await fetch(base + '/v1/admin/facebook-leads/forms/' + form.id + '/leads', { headers: bearer(b) }); assert.equal(response.status, 404);
    const body = JSON.stringify(webhook(), null, 2), headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(body).digest('hex') };
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers, body }); assert.equal(response.status, 200);
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers, body: JSON.stringify(webhook()) }); assert.equal(response.status, 403);
    response = await fetch(base + '/v1/admin/facebook-leads/forms/' + form.id + '/leads', { headers: bearer(a) });
    assert.equal((await response.json()).data.leads[0].field_data[0].values[0], 'Ada Example');
    const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '30001' })).toString('base64url');
    const signed = crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(payload).digest('base64url') + '.' + payload;
    response = await post('/v1/facebook/data-deletion', { signed_request: signed }); assert.equal(response.status, 200);
    assert.ok((await response.json()).confirmation_code); assert.equal((await database('facebook_leads')).length, 0);
    response = await fetch(base + '/v1/facebook/leads'); assert.equal(response.status, 200); assert.match(await response.text(), /Meta App Review setup/);
    response = await fetch(base + '/v1/facebook/leads.js'); assert.equal(response.status, 200); assert.match(await response.text(), /\/v1\/facebook\/api\/leads/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
