const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { load } = require('./facebook-helpers.cjs');

test('developer OAuth binds state to browser, exchanges once, redacts secrets and clears the local session', async () => {
  const previous = { ...process.env };
  process.env.NODE_ENV = 'development';
  process.env.FACEBOOK_TEST_LOGIN_MODE = 'classic';
  delete process.env.FACEBOOK_TEST_PUBLIC_URL;
  let exchanges = 0, fail = false;
  const axios = {
    post: async (_url, body) => {
      exchanges++;
      assert.equal(new URLSearchParams(body).get('client_secret'), process.env.FACEBOOK_APP_SECRET);
      if (fail) throw new Error('PRIVATE_TOKEN_AND_SECRET');
      return { data: { access_token: 'PRIVATE_TOKEN' } };
    },
    get: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer PRIVATE_TOKEN');
      assert.ok(options.params.appsecret_proof);
      return { data: url.endsWith('/permissions') ? { data: [{ permission: 'public_profile', status: 'granted' }] } : { id: '123', name: '<Developer>' } };
    },
  };
  const app = express();
  app.use('/v1/facebook/login-test', load('src/routes/facebookLoginTest.route.ts', { axios }).default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  process.env.FACEBOOK_TEST_PUBLIC_URL = origin;
  const base = origin + '/v1/facebook/login-test';
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const start = async () => {
    const response = await request('/start', { method: 'POST', headers: { Origin: origin } });
    assert.equal(response.status, 200);
    const url = new URL((await response.json()).url);
    assert.equal(url.hostname, 'www.facebook.com');
    assert.equal(url.searchParams.get('scope'), process.env.FACEBOOK_TEST_LOGIN_MODE === 'classic' ? 'public_profile' : null);
    assert.equal(url.searchParams.get('redirect_uri'), base + '/callback');
    return { state: url.searchParams.get('state'), cookie: response.headers.get('set-cookie').split(';')[0], url };
  };
  try {
    let response = await request('');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Continue with Facebook/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    for (const asset of ['/app.js', '/style.css']) assert.equal((await request(asset)).status, 200);
    const savedSecret = process.env.FACEBOOK_APP_SECRET;
    delete process.env.FACEBOOK_APP_SECRET;
    assert.equal((await (await request('/config')).json()).ready, false);
    process.env.FACEBOOK_APP_SECRET = savedSecret;
    assert.equal((await request('/start', { method: 'POST' })).status, 403);
    assert.equal((await request('/start', { method: 'POST', headers: { Origin: 'https://other.test' } })).status, 403);
    const attempt = await start();
    response = await request('/callback?code=secret&state=' + attempt.state);
    assert.match(response.headers.get('location'), /invalid_state/);
    assert.equal(exchanges, 0);
    response = await request('/callback?code=secret&state=' + attempt.state, { headers: { Cookie: attempt.cookie } });
    assert.match(response.headers.get('location'), /success/);
    assert.equal(exchanges, 1);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    assert.ok(!response.headers.get('set-cookie').includes('PRIVATE_TOKEN'));
    const session = response.headers.get('set-cookie').match(/fb_login_test_profile=([^;]+)/)[0];
    response = await request('/config', { headers: { Cookie: session } });
    const body = await response.text();
    assert.ok(!body.includes('PRIVATE_TOKEN') && !body.includes(savedSecret));
    assert.equal(JSON.parse(body).profile.name, '<Developer>');
    response = await request('/config', { headers: { Cookie: session + 'tampered' } });
    assert.equal((await response.json()).profile, null);
    response = await request('/callback?code=secret&state=' + attempt.state, { headers: { Cookie: attempt.cookie } });
    assert.match(response.headers.get('location'), /invalid_state/);
    assert.equal(exchanges, 1);
    response = await request('/logout', { method: 'POST', headers: { Origin: origin, Cookie: session } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /fb_login_test_profile=;/);
    const cancelled = await start();
    response = await request('/callback?error=access_denied&state=' + cancelled.state, { headers: { Cookie: cancelled.cookie } });
    assert.match(response.headers.get('location'), /cancelled/);
    fail = true;
    const failed = await start();
    response = await request('/callback?code=secret&state=' + failed.state, { headers: { Cookie: failed.cookie } });
    assert.match(response.headers.get('location'), /failed/);
    assert.ok(!(await response.text()).includes('PRIVATE_TOKEN_AND_SECRET'));
    process.env.FACEBOOK_TEST_LOGIN_MODE = 'business';
    const business = await start();
    assert.equal(business.url.searchParams.get('config_id'), process.env.FACEBOOK_LOGIN_CONFIG_ID);
    process.env.NODE_ENV = 'production';
    assert.equal((await request('')).status, 404);
    assert.equal((await request('/config')).status, 404);
    assert.equal((await request('/start', { method: 'POST', headers: { Origin: origin } })).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
