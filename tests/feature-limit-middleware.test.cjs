const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { loadSource } = require('./helpers/background-database.cjs');

test('chatbot, AI assistant and team creation reject exhausted owner allowances before controllers; lists stay readable', async () => {
  for (const [file, dependency, path, feature, list] of [
    ['chatbot', '../app/http/controllers/chatbot.controller', '/create', 'Chatbot', '/'],
    ['aiAssistant', '../app/http/controllers/aiAssistant.controller', '/', 'AiAssistant', '/'],
    ['team', '../app/http/controllers/team.controller', '/invite', 'TeamInvite', '/invites'],
  ]) {
    let creations = 0, quotaCalls = 0;
    const middleware = loadSource('library/surefy/src/middleware/plan.middleware.ts', {
      '@surefy/console/app/services/planUsage.service': { assert: async (owner, key) => {
        quotaCalls++; assert.equal(owner, 'owner'); assert.equal(key, feature);
        throw Object.assign(Error(`${feature} plan limit reached`), { statusCode: 403, details: { code: 'PLAN_LIMIT_EXCEEDED', feature } });
      } },
    });
    const controller = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : (req, res) => {
      if (req.method === 'POST') creations++;
      res.json({ success: true });
    } });
    const router = loadSource(`src/routes/${file}.route.ts`, {
      express, [dependency]: controller, '@surefy/middleware/plan.middleware': middleware,
    }).default;
    const app = express();
    app.use((req, _res, next) => { req.userId = 'member'; req.ownerId = 'owner'; next(); });
    app.use(router);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, error: error.details }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const blocked = await fetch(url + path, { method: 'POST' });
      assert.equal(blocked.status, 403); assert.equal((await blocked.json()).error.feature, feature);
      assert.equal(creations, 0); assert.equal(quotaCalls, 1);
      assert.equal((await fetch(url + list)).status, 200); assert.equal(quotaCalls, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

test('inactive senders return an explicit HTTP 403 while active or legacy sender records remain compatible', () => {
  const { assertActivePhone } = require('./helpers/active-phone.cjs');
  assert.throws(() => assertActivePhone({ active: false }), error => error.statusCode === 403 && error.details.code === 'WABA_NUMBER_INACTIVE');
  assert.doesNotThrow(() => assertActivePhone({ active: true }));
  assert.doesNotThrow(() => assertActivePhone({}));
});

test('tag, message and custom-column requests reach controllers without quota middleware; contacts remain limited', async () => {
  const next = (_req, _res, done) => done();
  let quotaCalls = 0, ownershipChecks = 0;
  const controller = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : (_req, res) => res.json({ success: true }) });
  const quota = { checkPlanLimit: feature => (_req, _res, done) => {
    quotaCalls++; done(Object.assign(Error(`${feature} quota exhausted`), { statusCode: 403 }));
  } };
  const app = express();
  app.use('/contacts', loadSource('src/routes/contact.route.ts', {
    express, '../app/http/middleware/accountScope': { accountScope: next, ownedPhone: next,
      accountAssignments: next, ownedResource: () => (_req, _res, done) => { ownershipChecks++; done(); } },
    '@surefy/middleware/upload.middleware': { uploadXLSXMiddleware: next },
    '@surefy/console/http/controllers/contact.controller': controller,
    '../app/http/controllers/contactOptOut.controller': controller,
    '@surefy/middleware/plan.middleware': quota,
    '@surefy/middleware/jwtAuth.middleware': { requireRole: () => next },
  }).default);
  app.use('/messages', loadSource('src/routes/message.route.ts', {
    express, '@surefy/console/http/controllers/message.controller': controller,
  }).default);
  app.use('/columns', loadSource('src/routes/column.route.ts', {
    express, '@surefy/console/http/controllers/column.controller': controller,
  }).default);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/contacts/tags', '/contacts/bulk/tags', '/contacts/contact-id/tags', '/messages/send', '/messages/bulk-send', '/columns']) {
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 200, path);
    }
    assert.equal(quotaCalls, 0); assert.equal(ownershipChecks, 1);
    assert.equal((await fetch(base + '/contacts', { method: 'POST' })).status, 403);
    assert.equal(quotaCalls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
