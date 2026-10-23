const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { load, fixture } = require('./facebook-helpers.cjs');

function publicRoute(sessions, featureRoute) {
  const controller = {
    facebookHandler: fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } },
    facebookError: (error, _req, res, _next) => res.status(500).json({ success: false, message: error.message }),
  };
  return load('src/routes/publicMetaWorkspace.route.ts', {
    '../app/services/publicMetaSession.service': { __esModule: true, default: sessions, publicMetaSessionLifetime: 2592000000 },
    '../app/http/controllers/facebookMessenger.controller': controller,
    ...Object.fromEntries(['facebookMessenger', 'facebookContent', 'facebookLeads', 'instagram']
      .map(name => ['./' + name + '.route', { __esModule: true, default: featureRoute }])),
  }).default;
}

test('public visitors get separate cookie scopes and cannot override ownership or use cross-origin actions', async () => {
  const sessions = new Map();
  const service = {
    async start(existing) {
      if (sessions.has(existing)) return { token: existing };
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { companyId: crypto.randomUUID(), ownerId: crypto.randomUUID(), userId: crypto.randomUUID() });
      return { token };
    },
    async find(token) { return sessions.get(token) || null; },
  };
  const feature = express.Router();
  feature.get('/pages', (req, res) => res.json({ success: true, data: { companyId: req.companyId, ownerId: req.ownerId } }));
  feature.post('/oauth/start', (req, res) => res.json({ success: true, data: { companyId: req.companyId } }));
  const app = express();
  app.use(express.json());
  app.use('/v1/facebook', publicRoute(service, feature));
  app.post('/v1/facebook/webhook', (_req, res) => res.sendStatus(200));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const start = (headers = {}, body = {}) => fetch(base + '/v1/facebook/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(base + '/v1/facebook/api/messenger/pages')).status, 401);
    const a = await start({}, { companyId: 'attacker-choice', ownerId: 'attacker-choice' });
    const aCookie = a.headers.get('set-cookie').split(';')[0];
    assert.match(a.headers.get('set-cookie'), /HttpOnly/);
    assert.match(a.headers.get('set-cookie'), /SameSite=Lax/);
    assert.match(a.headers.get('set-cookie'), /Secure/);
    assert.match(a.headers.get('set-cookie'), /Path=\/v1\/facebook/);
    assert.deepEqual(await a.json(), { success: true, data: { ready: true } });
    const b = await start();
    const bCookie = b.headers.get('set-cookie').split(';')[0];
    assert.notEqual(aCookie, bCookie);
    const read = async (feature, cookie) => (await (await fetch(base + '/v1/facebook/api/' + feature + '/pages', {
      headers: { Cookie: cookie },
    })).json()).data;
    const ownerA = await read('messenger', aCookie), ownerB = await read('messenger', bCookie);
    assert.notEqual(ownerA.companyId, ownerB.companyId);
    assert.notEqual(ownerA.companyId, 'attacker-choice');
    for (const feature of ['posts', 'leads', 'instagram']) assert.deepEqual(await read(feature, aCookie), ownerA);
    const resumed = await start({ Cookie: aCookie });
    assert.equal(resumed.headers.get('set-cookie').split(';')[0], aCookie);
    assert.equal(sessions.size, 2);
    assert.equal((await start({ Origin: 'https://other.example', Cookie: aCookie })).status, 403);
    assert.equal((await start({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const action = await fetch(base + '/v1/facebook/api/instagram/oauth/start', {
      method: 'POST', headers: { Cookie: aCookie, 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}',
    });
    assert.equal(action.status, 403);
    assert.equal((await fetch(base + '/v1/facebook/session', { method: 'POST' })).status, 415);
    // The browser-session guard must not intercept Meta's public webhook routes.
    assert.equal((await fetch(base + '/v1/facebook/webhook', { method: 'POST' })).status, 200);
    sessions.clear();
    assert.equal((await fetch(base + '/v1/facebook/api/posts/pages', { headers: { Cookie: aCookie } })).status, 401);
    assert.equal((await fetch(base + '/v1/admin/facebook-messenger/pages', { headers: { Cookie: aCookie } })).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

for (const [script, html] of [['app', 'index'], ['posts', 'posts'], ['leads', 'leads'], ['instagram', 'instagram']]) {
  test(`${script} opens directly without account credentials and preserves provider OAuth navigation`, async () => {
    const requests = [], nodes = new Map(), navigations = [];
    function node() { return { hidden: true, disabled: false, value: '', textContent: '',
      classList: { toggle() {} }, replaceChildren() {}, append() {}, reset() {} }; }
    const context = {
      document: { hidden: false, addEventListener() {}, createElement: node,
        getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } },
      window: {}, URL, URLSearchParams, AbortSignal, console, crypto, setInterval() {}, clearTimeout() {},
      location: { pathname: '/v1/facebook/' + (html === 'index' ? 'page' : html), hash: '#oauth=ready',
        assign(value) { navigations.push(value); } },
      history: { replaceState() {} },
      sessionStorage: { getItem() { throw new Error('Do not reuse an application JWT'); } },
      fetch: async (url, options) => {
        requests.push({ url, options });
        let data = {};
        if (url.endsWith('/session')) data = { ready: true };
        else if (url.endsWith('/oauth/start')) data = { authorization_url: script === 'instagram'
          ? 'https://www.instagram.com/oauth/authorize' : 'https://www.facebook.com/v26.0/dialog/oauth' };
        else if (url.endsWith('/setup')) data = { ready: true, can_manage: true, privacy_ready: true,
          providers: [{ provider: 'instagram', ready: true }, { provider: 'facebook', ready: true }] };
        else if (url.endsWith('/oauth/pages')) data = { status: 'ready', pages: [] };
        else if (url.endsWith('/pages') || url.endsWith('/accounts')) data = [];
        else if (url.endsWith('/conversations')) data = { conversations: [] };
        else throw new Error('Unexpected browser request: ' + url);
        return { ok: true, status: 200, json: async () => ({ success: true, data }) };
      },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('src/web/facebook/session.js', 'utf8'), context);
    vm.runInContext(fs.readFileSync('src/web/facebook/' + script + '.js', 'utf8'), context);
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.get('workspace').hidden, false, nodes.get('notice')?.textContent);
    assert.equal(requests.filter(r => r.url.endsWith('/session')).length, 1);
    assert(!requests.some(r => /\/auth\/login|\/admin\/|review-login/.test(r.url)));
    assert(requests.every(r => !r.options.headers?.Authorization));
    await nodes.get('connect').onclick();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(navigations.length, 1, nodes.get('notice')?.textContent);
    assert.match(navigations[0], script === 'instagram' ? /^https:\/\/www.instagram.com\// : /^https:\/\/www.facebook.com\//);
    const markup = fs.readFileSync('src/web/facebook/' + html + '.html', 'utf8');
    assert(!/id="(?:login-form|login-panel|email|password|domain|logout)"/.test(markup));
    assert(markup.indexOf('/session.js') < markup.indexOf('/' + script + '.js'));
  });
}

test('real database creates credential-free owners, hashes session cookies, resumes and rejects expired or suspended sessions', {
  skip: !process.env.FACEBOOK_TEST_DATABASE_URL && 'Set FACEBOOK_TEST_DATABASE_URL to an isolated local PostgreSQL database.',
}, () => fixture(async ({ database, meta }) => {
  await database.schema.alterTable('companies', t => { t.string('name'); t.string('email'); t.jsonb('settings'); });
  await database.schema.alterTable('users', t => { t.string('name'); t.string('password'); t.jsonb('settings'); });
  await load('src/database/migrations/20261023000001_create_public_meta_sessions.ts').up(database);
  const { PublicMetaSessionService } = load('src/app/services/publicMetaSession.service.ts', { '@surefy/database': database });
  const service = new PublicMetaSessionService(database);
  const a = await service.start(), b = await service.start();
  const scopeA = await service.find(a.token), scopeB = await service.find(b.token);
  assert.notEqual(scopeA.companyId, scopeB.companyId);
  assert.equal(scopeA.userId, scopeA.ownerId);
  const row = await database('public_meta_sessions').where({ owner_id: scopeA.ownerId }).first();
  assert.equal(row.token_hash, crypto.createHash('sha256').update(a.token).digest('hex'));
  assert(!JSON.stringify(row).includes(a.token));
  const owner = await database('users').where({ id: scopeA.ownerId }).first();
  assert.equal(owner.email, null);
  assert.equal(owner.password, '!public-meta-workspace');
  assert.deepEqual(await service.start(a.token), a);
  const messengerModule = load('src/app/services/facebookMessenger.service.ts', {
    '@surefy/database': database, './facebookGraph.service': { default: {} }, '../utils/facebook': require('./facebook-helpers.cjs').utils,
  });
  const messenger = new messengerModule.FacebookMessengerService(database, meta);
  await messenger.access(scopeA, 'manage');
  assert.deepEqual(Array.from(await messenger.pages(scopeB)), []);

  const controller = load('src/app/http/controllers/facebookMessenger.controller.ts', {
    '../../services/facebookMessenger.service': { __esModule: true, default: messenger },
    '../../services/facebookLeads.service': { default: {} },
    '../../services/instagram.service': { default: {} }, '../../utils/facebook': require('./facebook-helpers.cjs').utils,
  });
  const feature = load('src/routes/facebookMessenger.route.ts', {
    '../app/http/controllers/facebookMessenger.controller': controller,
  }).default;
  const app = express(); app.use(express.json());
  app.use('/v1/facebook', publicRoute(service, feature));
  app.get('/v1/facebook/oauth/callback', controller.default.callback);
  app.use(controller.facebookError);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (url, cookie, body = {}) => fetch(base + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  try {
    const boot = await post('/v1/facebook/session');
    const workspaceCookie = boot.headers.get('set-cookie').split(';')[0];
    const started = await post('/v1/facebook/api/messenger/oauth/start', workspaceCookie);
    assert.equal(started.status, 200);
    const oauthCookie = started.headers.get('set-cookie').split(';')[0];
    const state = new URL((await started.json()).data.authorization_url).searchParams.get('state');
    const cookies = workspaceCookie + '; ' + oauthCookie;
    const callback = await fetch(base + '/v1/facebook/oauth/callback?state=' + state + '&code=TEST_CODE', {
      headers: { Cookie: cookies }, redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/v1/facebook/page#oauth=ready');
    const resumed = await post('/v1/facebook/session', cookies);
    assert.equal(resumed.headers.get('set-cookie').split(';')[0], workspaceCookie);
    const selected = await post('/v1/facebook/api/messenger/pages', cookies, { page_id: '20001' });
    assert.equal(selected.status, 200);
    const page = (await selected.json()).data;
    assert.equal(page.status, 'connected');
    const ownPages = await (await fetch(base + '/v1/facebook/api/messenger/pages', { headers: { Cookie: cookies } })).json();
    assert.equal(ownPages.data[0].id, page.id);
    const foreignPages = await (await fetch(base + '/v1/facebook/api/messenger/pages', {
      headers: { Cookie: 'public_meta_workspace=' + b.token },
    })).json();
    assert.equal(foreignPages.data.length, 0);
    const foreignDelete = await fetch(base + '/v1/facebook/api/messenger/pages/' + page.id, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: 'public_meta_workspace=' + b.token },
    });
    assert.equal(foreignDelete.status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  await database('users').where({ id: scopeA.ownerId }).update({ status: 'inactive' });
  assert.equal(await service.find(a.token), null);
  await database('public_meta_sessions').where({ owner_id: scopeB.ownerId }).update({ expires_at: new Date(0) });
  assert.equal(await service.find(b.token), null);
  for (const invalid of [null, 'short', 'x'.repeat(43), [a.token]]) assert.equal(await service.find(invalid), null);
}));
