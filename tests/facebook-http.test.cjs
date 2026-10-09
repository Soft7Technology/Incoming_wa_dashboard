const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { load, fixture, utils } = require('./facebook-helpers.cjs');

test('actual HTTP middleware verifies raw webhook bytes, JWT company scope, callbacks and assets', {
  skip: !process.env.FACEBOOK_TEST_DATABASE_URL && 'Set FACEBOOK_TEST_DATABASE_URL to an isolated local PostgreSQL database.',
}, () => fixture(async ({ database, service, connect, inbound, a, b }) => {
  const controllerModule = load('src/app/http/controllers/facebookMessenger.controller.ts', {
    '../../services/facebookMessenger.service': { __esModule: true, default: service }, '../../utils/facebook': utils,
  });
  const publicRoute = load('src/routes/facebookPublic.route.ts', {
    '../app/http/controllers/facebookMessenger.controller': controllerModule,
    './facebookLoginTest.route': load('src/routes/facebookLoginTest.route.ts'),
  }).default;
  const protectedRoute = load('src/routes/facebookMessenger.route.ts', {
    '../app/http/controllers/facebookMessenger.controller': controllerModule,
  }).default;
  class Unauthorized extends Error { constructor(data) { super(data.message); this.status = 401; } }
  const auth = load('library/surefy/src/middleware/jwtAuth.middleware.ts', {
    '../database': database, '../exceptions/HTTP401Error': Unauthorized,
  }).jwtAuthMiddleware;
  const admin = express.Router(); admin.use(auth); admin.use(protectedRoute);
  const priorWorkerMode = process.env.WORKER_MODE; process.env.WORKER_MODE = 'true';
  const createBaseApp = load('library/surefy/src/server.ts', {
    './middleware/errorHandler': { errorHandler: (error, _req, res, _next) => res.status(error.status || 500).json({ success: false, message: error.message }) },
    './routes/health.route': express.Router(), './middleware/upload.middleware': { UPLOADS_DIR: 'uploads' },
  }).default;
  const app = createBaseApp([{ basePath: '/v1/facebook', route: publicRoute }, { basePath: '/v1/admin/facebook-messenger', route: admin }]);
  if (priorWorkerMode === undefined) delete process.env.WORKER_MODE; else process.env.WORKER_MODE = priorWorkerMode;
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const bearer = scope => ({ Authorization: 'Bearer ' + jwt.sign({ userId: scope.userId, ownerId: scope.ownerId, companyId: scope.companyId, role: 'company' }, process.env.JWT_SECRET) });
  try {
    await connect();
    let response = await fetch(base + '/v1/facebook/page'); assert.equal(response.status, 200); assert.match(await response.text(), /Connect Facebook Page/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    response = await fetch(base + '/v1/facebook/app.js'); assert.equal(response.status, 200); assert.match(await response.text(), /client_request_id/);
    response = await fetch(base + '/v1/facebook/webhook?hub.mode=subscribe&hub.verify_token=unit-test-verify&hub.challenge=12345'); assert.equal(await response.text(), '12345');
    response = await fetch(base + '/v1/facebook/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345'); assert.equal(response.status, 403);
    const body = JSON.stringify(inbound(), null, 2);
    const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(body).digest('hex') };
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers, body }); assert.equal(response.status, 200);
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers, body }); assert.equal(response.status, 200);
    assert.equal((await database('facebook_messages')).length, 1);
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers, body: JSON.stringify(inbound()) }); assert.equal(response.status, 403);
    response = await fetch(base + '/v1/admin/facebook-messenger/pages'); assert.equal(response.status, 401);
    response = await fetch(base + '/v1/admin/facebook-messenger/pages', { headers: bearer(b) }); assert.equal((await response.json()).data.length, 0);
    const conversation = await database('facebook_conversations').first();
    response = await fetch(base + '/v1/admin/facebook-messenger/conversations/' + conversation.id + '/messages', { headers: bearer(b) }); assert.equal(response.status, 404);
    const reply = 'Hello! Please share your order number so we can help.';
    response = await fetch(base + '/v1/admin/facebook-messenger/conversations/' + conversation.id + '/messages', { method: 'POST', headers: { ...bearer(a), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: reply, client_request_id: crypto.randomUUID() }) });
    const sent = (await response.json()).data; assert.equal(sent.status, 'sent'); assert.equal(sent.text, reply);
    response = await fetch(base + '/v1/facebook/oauth/callback?state=wrong&code=secret'); assert.equal(response.status, 403);
    const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '30001' })).toString('base64url');
    const signed = crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(payload).digest('base64url') + '.' + payload;
    response = await fetch(base + '/v1/facebook/data-deletion', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ signed_request: signed }) });
    const deletion = await response.json(); assert.equal(response.status, 200); assert.ok(deletion.confirmation_code); assert.ok(deletion.url.includes('/data-deletion/status/'));
    response = await fetch(base + '/v1/facebook/data-deletion/status/' + deletion.confirmation_code); assert.match(await response.text(), /deletion completed/);
    assert.equal((await database('facebook_messages')).length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));
