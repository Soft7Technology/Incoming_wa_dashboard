const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { load, utils } = require('./facebook-helpers.cjs');

test('review access requires an enabled, unexpired private key and uses normal login for only the configured account', async () => {
  const keys = ['ENABLED', 'KEY_HASH', 'EMAIL', 'PASSWORD', 'EXPIRES_AT', 'DOMAIN'].map(x => 'FACEBOOK_REVIEW_' + x);
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const key = crypto.randomBytes(32).toString('base64url');
  const configure = () => Object.assign(process.env, {
    FACEBOOK_REVIEW_ENABLED: 'true',
    FACEBOOK_REVIEW_KEY_HASH: crypto.createHash('sha256').update(key).digest('hex'),
    FACEBOOK_REVIEW_EMAIL: 'review@example.test',
    FACEBOOK_REVIEW_PASSWORD: 'unit-test-password',
    FACEBOOK_REVIEW_DOMAIN: 'review.example.test',
    FACEBOOK_REVIEW_EXPIRES_AT: new Date(Date.now() + 60000).toISOString(),
  });
  const calls = [];
  const reviewRoute = load('src/routes/facebookReviewLogin.route.ts', {
    '@surefy/utils/facebookReviewSession': load('library/surefy/src/utils/facebookReviewSession.ts'),
    '../app/http/controllers/auth.controller': { __esModule: true, default: { login: (req, res) => {
      calls.push(req.body);
      res.json({ success: true, data: { token: 'unit-test-jwt', data: { name: 'Reviewer' } } });
    } } },
  });
  const controller = load('src/app/http/controllers/facebookMessenger.controller.ts', {
    '../../services/instagram.service': { default: {} },
    '../../services/facebookLeads.service': { default: {} },
    '../../services/facebookMessenger.service': { default: {} }, '../../utils/facebook': utils,
  });
  const publicRoute = load('src/routes/facebookPublic.route.ts', {
    './publicMetaWorkspace.route': express.Router(),
    '../app/http/controllers/facebookContent.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } }, '../app/http/controllers/instagram.controller': { __esModule: true, default: Object.fromEntries(['callback', 'verify', 'receive', 'deauthorize', 'deletion', 'publishingMedia'].map(key => [key, (_req, res) => res.sendStatus(400)])) },
    '../app/http/controllers/facebookAds.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } },
    '../app/http/controllers/facebookLeads.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } },
    '../app/http/controllers/facebookMessenger.controller': controller,
    './facebookLoginTest.route': express.Router(),
    './facebookReviewLogin.route': reviewRoute,
  }).default;
  const app = express();
  app.use(express.json()); app.use('/v1/facebook', publicRoute);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/facebook/review-login';
  const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    configure();
    delete process.env.FACEBOOK_REVIEW_ENABLED;
    assert.equal((await post({ key })).status, 404);
    configure();
    for (const invalid of [undefined, null, [key], 'short', crypto.randomBytes(32).toString('base64url')]) {
      const response = await post({ key: invalid });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(!(await response.text()).includes('unit-test-password'));
    }
    process.env.FACEBOOK_REVIEW_EXPIRES_AT = new Date(Date.now() - 1).toISOString();
    assert.equal((await post({ key })).status, 403);
    configure(); process.env.FACEBOOK_REVIEW_KEY_HASH = 'bad-hash';
    assert.equal((await post({ key })).status, 404);
    configure(); process.env.FACEBOOK_REVIEW_EXPIRES_AT = 'invalid-date';
    assert.equal((await post({ key })).status, 404);
    configure(); delete process.env.FACEBOOK_REVIEW_PASSWORD;
    assert.equal((await post({ key })).status, 404);
    assert.equal(calls.length, 0);
    configure();
    const response = await post({ key, identifier: 'other@example.test', password: 'caller-password', domain_name: 'other.test' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.token, 'unit-test-jwt');
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ identifier: 'review@example.test', password: 'unit-test-password', domain_name: 'review.example.test' }]);
    assert.equal((await fetch(url)).status, 404);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
