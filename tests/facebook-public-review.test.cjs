const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { load, utils } = require('./facebook-helpers.cjs');
const sessions = load('library/surefy/src/utils/facebookReviewSession.ts');

test('public review login issues only a short Messenger token; other APIs, password-reset verification and destructive actions reject it', async () => {
  const keys = ['ENABLED', 'PUBLIC_ENABLED', 'PAGE_ID', 'EMAIL', 'PASSWORD', 'DOMAIN', 'EXPIRES_AT'].map(x => 'FACEBOOK_REVIEW_' + x);
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    FACEBOOK_REVIEW_ENABLED: 'true', FACEBOOK_REVIEW_PUBLIC_ENABLED: 'true', FACEBOOK_REVIEW_PAGE_ID: '20001',
    FACEBOOK_REVIEW_EMAIL: 'review@example.test', FACEBOOK_REVIEW_PASSWORD: 'test-password',
    FACEBOOK_REVIEW_DOMAIN: 'review.example.test', FACEBOOK_REVIEW_EXPIRES_AT: new Date(Date.now() + 7200000).toISOString(),
  });
  let credentials;
  const claims = { userId: 'user-id', ownerId: 'user-id', companyId: 'company-id', role: 'user' };
  const normalToken = jwt.sign(claims, process.env.JWT_SECRET);
  const review = load('src/routes/facebookReviewLogin.route.ts', {
    '@surefy/utils/facebookReviewSession': sessions,
    '../app/http/controllers/auth.controller': { __esModule: true, default: { login(req, res) {
      credentials = req.body;
      res.json({ success: true, data: { token: normalToken, data: { name: 'Reviewer', email: 'private-email' }, company: { secret: 'private-data' } } });
    } } },
  }).default;
  class Unauthorized extends Error { constructor({ message }) { super(message); } }
  const db = table => ({ where() { return this; }, whereNull() { return this; }, select() { return this; },
    first: async () => table === 'users' ? { status: 'active', role: 'user', company_id: 'company-id' } : { id: 'company-id' } });
  const auth = load('library/surefy/src/middleware/jwtAuth.middleware.ts', {
    '../utils/facebookReviewSession': sessions, '../database': db, '../exceptions/HTTP401Error': Unauthorized,
  }).jwtAuthMiddleware;
  const app = express(); app.use(express.json()); app.use('/v1/facebook/review-login', review);
  app.use(auth); app.use((req, res) => res.json({ success: true, pageId: req.facebookReviewPageId || null }));
  app.use((error, _req, res, _next) => res.status(401).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = () => fetch(base + '/v1/facebook/review-login/public', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'attacker', password: 'wrong' }) });
  try {
    process.env.FACEBOOK_REVIEW_PUBLIC_ENABLED = 'false'; assert.equal((await login()).status, 404);
    process.env.FACEBOOK_REVIEW_PUBLIC_ENABLED = 'true';
    process.env.FACEBOOK_REVIEW_PAGE_ID = ''; assert.equal((await login()).status, 503);
    process.env.FACEBOOK_REVIEW_PAGE_ID = '20001';
    const response = await login(); assert.equal(response.status, 200);
    const body = await response.json(), token = body.data.token;
    assert.notEqual(token, normalToken);
    assert.throws(() => jwt.verify(token, process.env.JWT_SECRET));
    const decoded = jwt.verify(token, sessions.facebookReviewSecret(process.env.JWT_SECRET));
    assert.equal(decoded.reviewPageId, '20001'); assert.equal(decoded.purpose, sessions.facebookReviewPurpose);
    assert.ok(decoded.exp - decoded.iat <= 3600);
    assert.equal(JSON.stringify(body).includes('private-data'), false);
    assert.equal(JSON.stringify(body).includes('private-email'), false);
    assert.equal(JSON.stringify(body).includes('test-password'), false);
    assert.equal(credentials.identifier, 'review@example.test'); assert.equal(credentials.password, 'test-password');
    const headers = { Authorization: 'Bearer ' + token };
    const get = path => fetch(base + path, { headers });
    assert.equal((await get('/v1/admin/facebook-messenger/pages')).status, 200);
    assert.equal((await (await get('/v1/admin/facebook-messenger/pages')).json()).pageId, '20001');
    for (const path of ['/v1/admin/contacts', '/v1/admin/waba', '/v1/auth/profile', '/v1/admin/facebook-messenger-evil/pages'])
      assert.equal((await get(path)).status, 403, path);
    assert.equal((await fetch(base + '/v1/admin/facebook-messenger/pages/id', { method: 'DELETE', headers })).status, 403);
    assert.equal((await fetch(base + '/v1/admin/facebook-messenger/pages/id/disconnect', { method: 'POST', headers })).status, 403);
    assert.equal((await fetch(base + '/v1/admin/contacts', { headers: { Authorization: 'Bearer ' + normalToken } })).status, 200);
    process.env.FACEBOOK_REVIEW_PUBLIC_ENABLED = 'false'; assert.equal((await get('/v1/admin/facebook-messenger/pages')).status, 403);
    process.env.FACEBOOK_REVIEW_PUBLIC_ENABLED = 'true';
    process.env.FACEBOOK_REVIEW_EXPIRES_AT = new Date(Date.now() - 1).toISOString();
    assert.equal((await login()).status, 503);
    assert.equal((await get('/v1/admin/facebook-messenger/pages')).status, 403);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('public review Page scope filters reads and candidates and rejects connecting or deleting another Page', async () => {
  const { FacebookMessengerService } = load('src/app/services/facebookMessenger.service.ts', {
    '@surefy/database': {}, './facebookGraph.service': { default: {} }, '../utils/facebook': utils,
  });
  const where = [], queries = [];
  const db = table => {
    const query = { table, conditions: [], where(condition) { this.conditions.push(condition); where.push(condition); return this; },
      select() { return this; }, orderBy() { return this; }, limit() { return this; }, join() { return this; },
      first: async () => ({ id: 'conversation', last_customer_message_at: Date.now() }),
      then(resolve) { return Promise.resolve([]).then(resolve); } };
    queries.push(query); return query;
  };
  const service = new FacebookMessengerService(db, {}); service.access = async () => {};
  const scope = { userId: 'owner', ownerId: 'owner', companyId: 'company', reviewPageId: '20001' };
  await service.conversations(scope);
  service.validateId = () => {};
  await service.conversation(scope, 'conversation');
  assert.equal(queries.length, 2);
  for (const query of queries) assert.ok(query.conditions.some(x => x['p.page_id'] === '20001'));
  await assert.rejects(service.connect(scope, undefined, '20002'), /only connect/);
  await assert.rejects(service.disconnect(scope, 'page'), /cannot disconnect/);
  service.session = async () => ({ status: 'ready', candidates_ciphertext: utils.encrypt(JSON.stringify({ pages: [{ id: '20001', name: 'Test' }, { id: '20002', name: 'Private' }] })) });
  const candidates = await service.candidates(scope, 'browser');
  assert.deepEqual(Array.from(candidates.pages, p => p.page_id), ['20001']);
});
