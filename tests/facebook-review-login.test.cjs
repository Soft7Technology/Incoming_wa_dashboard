const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const vm = require('node:vm');
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
    '../app/http/controllers/auth.controller': { __esModule: true, default: { login: (req, res) => {
      calls.push(req.body);
      res.json({ success: true, data: { token: 'unit-test-jwt', data: { name: 'Reviewer' } } });
    } } },
  });
  const controller = load('src/app/http/controllers/facebookMessenger.controller.ts', {
    '../../services/facebookMessenger.service': { default: {} }, '../../utils/facebook': utils,
  });
  const publicRoute = load('src/routes/facebookPublic.route.ts', {
    '../app/http/controllers/facebookMessenger.controller': controller,
    './facebookLoginTest.route': load('src/routes/facebookLoginTest.route.ts'),
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

test('private browser link clears its fragment, signs in without a password and preserves ordinary login without a link', async () => {
  const source = fs.readFileSync('src/web/facebook/app.js', 'utf8');
  async function browser(fragment, allowed) {
    const nodes = new Map(), requests = [], history = [], values = new Map();
    const node = () => ({ value: '', hidden: false, disabled: false, textContent: '', classList: { toggle() {} }, replaceChildren() {}, append() {} });
    const document = {
      hidden: false, addEventListener() {}, createElement: node,
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    };
    const context = {
      document, URL, URLSearchParams, AbortSignal, console, setInterval() {},
      location: { hostname: 'review.example.test', pathname: '/v1/facebook/page', search: '', hash: fragment },
      history: { replaceState(_state, _title, url) { history.push(url); } },
      sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
      fetch: async (url, options) => {
        requests.push({ url, options });
        const data = url.endsWith('/review-login')
          ? allowed ? { token: 'review-jwt', data: { name: 'Reviewer' } } : null
          : url.endsWith('/setup') ? { ready: true, privacy_ready: true, can_manage: false }
          : url.endsWith('/pages') ? [] : { conversations: [] };
        return { ok: allowed, status: allowed ? 200 : 403, json: async () => ({ success: allowed, data, message: 'Invalid review link' }) };
      },
    };
    vm.runInNewContext(source, context);
    for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve));
    return { nodes, requests, history, values };
  }
  const key = crypto.randomBytes(32).toString('base64url');
  const accepted = await browser('#review=' + key, true);
  assert.equal(accepted.requests[0].url, '/v1/facebook/review-login');
  assert.deepEqual(JSON.parse(accepted.requests[0].options.body), { key });
  assert.equal(accepted.history[0], '/v1/facebook/page');
  assert.equal(accepted.values.get('facebook_saas_jwt'), 'review-jwt');
  assert.equal(accepted.nodes.get('workspace').hidden, false);
  assert.equal(accepted.nodes.get('login-button').disabled, false);
  const rejected = await browser('#review=' + key, false);
  assert.equal(rejected.values.has('facebook_saas_jwt'), false);
  assert.equal(rejected.nodes.get('login-panel').hidden, false);
  assert.equal(rejected.nodes.get('notice').textContent, 'Invalid review link');
  const ordinary = await browser('', true);
  assert.equal(ordinary.requests.length, 0);
  assert.equal(typeof ordinary.nodes.get('login-form').onsubmit, 'function');
});
