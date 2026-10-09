const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { utils, configure, load } = require('./facebook-helpers.cjs');

test('raw webhook signature rejects altered bytes, malformed values, and other secrets', () => {
  const body = Buffer.from('{ "object": "page" }');
  const signature = 'sha256=' + crypto.createHmac('sha256', 'secret').update(body).digest('hex');
  assert.equal(utils.verifySignature(body, signature, 'secret'), true);
  for (const value of ['sha256=1', signature.toUpperCase(), null, ['sha256=0'], 'sha1=' + '0'.repeat(64)]) assert.equal(utils.verifySignature(body, value, 'secret'), false);
  assert.equal(utils.verifySignature(Buffer.from('{"object":"page"}'), signature, 'secret'), false);
  assert.equal(utils.verifySignature(body, signature, 'other'), false);
});
test('signed deletion requests authenticate user and algorithm', () => {
  const sign = payload => { const data = Buffer.from(JSON.stringify(payload)).toString('base64url'); return crypto.createHmac('sha256', 'secret').update(data).digest('base64url') + '.' + data; };
  assert.equal(utils.signedUser(sign({ algorithm: 'HMAC-SHA256', user_id: '123' }), 'secret'), '123');
  assert.throws(() => utils.signedUser(sign({ algorithm: 'none', user_id: '123' }), 'secret'));
  assert.throws(() => utils.signedUser(sign({ algorithm: 'HMAC-SHA256', user_id: '123' }), 'other'));
  assert.throws(() => utils.signedUser(sign({ algorithm: 'HMAC-SHA256', user_id: '../123' }), 'secret'));
});
test('tokens require a configured encryption key, unique IVs and authenticated decryption', () => {
  const one = utils.encrypt('test-page-token'), two = utils.encrypt('test-page-token');
  assert.notEqual(one, two); assert.equal(utils.decrypt(one), 'test-page-token'); assert.ok(!one.includes('test-page-token'));
  assert.throws(() => utils.decrypt('plaintext-token'));
  const parts = one.split('.'); parts[2] = Buffer.alloc(16).toString('base64'); assert.throws(() => utils.decrypt(parts.join('.')));
  delete process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY; assert.throws(() => utils.encrypt('token')); configure();
});
test('the reply window closes at exactly 24 hours and outbound messages cannot open it', () => {
  const now = Date.now(); assert.equal(utils.replyWindow(new Date(now - 86400000), now).can_reply, false);
  assert.equal(utils.replyWindow(new Date(now - 86400000 + 1), now).can_reply, true);
  assert.equal(utils.replyWindow(null, now).can_reply, false);
});
test('business login requires configuration and rejects insecure deployed origins', () => {
  assert.ok(utils.config().callback.endsWith('/v1/facebook/oauth/callback'));
  delete process.env.FACEBOOK_LOGIN_CONFIG_ID; assert.throws(() => utils.config(), /FACEBOOK_LOGIN_CONFIG_ID/); configure();
  process.env.FACEBOOK_PUBLIC_URL = 'http://public.example.test'; assert.throws(() => utils.config()); configure();
});
test('Graph failures redact HTTP secrets and identify expired/missing permissions', async () => {
  let request;
  const axios = { request: async options => { request = options; throw { response: { data: { error: { code: 190, message: 'LEAK_TOKEN' } } }, config: { headers: { Authorization: 'Bearer LEAK_TOKEN' } } }; } };
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios, '../utils/facebook': utils });
  const graph = new FacebookGraph();
  await assert.rejects(graph.call('20001/messages', 'TEST_TOKEN', 'POST', {}, {}), error => error.code === 'TOKEN_EXPIRED' && !error.message.includes('LEAK_TOKEN'));
  assert.equal(request.headers.Authorization, 'Bearer TEST_TOKEN'); assert.ok(request.params.appsecret_proof); assert.equal(request.maxRedirects, 0);
  assert.equal(utils.graphFailure(200).code, 'PERMISSION_DENIED');
  axios.request = async () => { throw new Error('LEAK_APP_SECRET'); };
  await assert.rejects(graph.call('20001/messages', 'TEST_TOKEN', 'POST'), error => error.code === 'META_UNCONFIRMED' && /may have been sent/.test(error.message) && !error.message.includes('LEAK_APP_SECRET'));
});
test('Page discovery follows cursors, filters messaging tasks and never follows untrusted next URLs', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph(), calls = [];
  graph.call = async (path, token, method, params) => { calls.push({ path, params }); return calls.length === 1
    ? { data: [{ id: 'a', access_token: 'token', tasks: ['ANALYZE'] }], paging: { next: 'https://evil.test/leak', cursors: { after: 'next' } } }
    : { data: [{ id: 'b', access_token: 'token', tasks: ['MESSAGING'] }] }; };
  assert.equal((await graph.pages('token'))[0].id, 'b'); assert.equal(calls[1].path, 'me/accounts'); assert.equal(calls[1].params.after, 'next');
});
test('Page discovery accepts Meta profile-plus messaging tasks and still requires a Page token', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph();
  graph.call = async () => ({ data: [
    { id: 'modern', access_token: 'TEST_PAGE_TOKEN', tasks: ['PROFILE_PLUS_ANALYZE', 'PROFILE_PLUS_FACEBOOK_ACCESS', 'PROFILE_PLUS_MESSAGING', 'PROFILE_PLUS_MANAGE'] },
    { id: 'legacy', access_token: 'TEST_PAGE_TOKEN', tasks: ['MESSAGE'] },
    { id: 'no-messaging', access_token: 'TEST_PAGE_TOKEN', tasks: ['PROFILE_PLUS_ANALYZE', 'PROFILE_PLUS_MANAGE'] },
    { id: 'no-token', tasks: ['PROFILE_PLUS_MESSAGING'] },
  ] });
  assert.deepEqual(Array.from(await graph.pages('TEST_USER_TOKEN'), page => page.id), ['modern', 'legacy']);
});
test('Page discovery distinguishes empty Meta results, missing messaging access and missing Page tokens', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph();
  for (const [data, code] of [
    [[], 'NO_PAGES_RETURNED'],
    [[{ id: 'page', access_token: 'PRIVATE_PAGE_TOKEN', tasks: ['ANALYZE'] }], 'PAGE_MESSAGING_ACCESS_REQUIRED'],
    [[{ id: 'page', tasks: ['PROFILE_PLUS_MESSAGING'] }], 'PAGE_TOKEN_MISSING'],
    [[{ id: 'no-access', access_token: 'PRIVATE_PAGE_TOKEN', tasks: ['ANALYZE'] },
      { id: 'no-token', tasks: ['MESSAGING'] }], 'PAGE_TOKEN_MISSING'],
  ]) {
    graph.call = async () => ({ data });
    await assert.rejects(graph.pages('PRIVATE_USER_TOKEN'), error =>
      error.status === 403 && error.code === code &&
      !error.message.includes('PRIVATE_PAGE_TOKEN') && !error.message.includes('PRIVATE_USER_TOKEN'));
  }
});
test('Page discovery waits for all result pages before diagnosing unavailable access', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph();
  let calls = 0;
  graph.call = async () => ++calls === 1
    ? { data: [], paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'next' } } }
    : { data: [{ id: 'usable', access_token: 'PRIVATE_PAGE_TOKEN', tasks: ['PROFILE_PLUS_MESSAGING'] }] };
  assert.deepEqual(Array.from(await graph.pages('PRIVATE_USER_TOKEN'), page => page.id), ['usable']);
  assert.equal(calls, 2);
});
test('Page token inspection checks the authorized Page without reading permission-dependent metadata', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph(), calls = [];
  graph.call = async (path, token, method, params) => {
    calls.push({ path, token, params });
    assert.equal(path, 'debug_token');
    return { data: { is_valid: true, app_id: process.env.FACEBOOK_APP_ID, type: 'PAGE', profile_id: '20001', expires_at: 0 } };
  };
  const inspected = await graph.inspectPage('20001', 'PRIVATE_PAGE_TOKEN');
  assert.equal(inspected.expires, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.input_token, 'PRIVATE_PAGE_TOKEN');
  assert.equal(calls[0].token, process.env.FACEBOOK_APP_ID + '|' + process.env.FACEBOOK_APP_SECRET);
});
test('Page token inspection rejects invalid, foreign-app, user, mismatched and unbound tokens', async () => {
  const { FacebookGraph } = load('src/app/services/facebookGraph.service.ts', { axios: {}, '../utils/facebook': utils });
  const graph = new FacebookGraph();
  const valid = { is_valid: true, app_id: process.env.FACEBOOK_APP_ID, type: 'PAGE', profile_id: '20001', expires_at: 1700000000 };
  graph.call = async () => ({ data: valid });
  assert.equal((await graph.inspectPage('20001', 'PRIVATE_PAGE_TOKEN')).expires.getTime(), 1700000000000);
  for (const override of [
    { is_valid: false }, { app_id: 'other-app' }, { type: 'USER' },
    { profile_id: 'other-page' }, { profile_id: undefined },
  ]) {
    graph.call = async () => ({ data: { ...valid, ...override } });
    await assert.rejects(graph.inspectPage('20001', 'PRIVATE_PAGE_TOKEN'), error =>
      [403, 409].includes(error.status) && !error.message.includes('PRIVATE_PAGE_TOKEN'));
  }
});
test('browser assets contain no simulated authorization or hardcoded success requests', () => {
  const js = fs.readFileSync('src/web/facebook/app.js', 'utf8');
  new Function(js);
  assert.ok(js.includes('/oauth/start') && js.includes('location.assign') && js.includes('client_request_id'));
  assert.ok(!js.includes('innerHTML')); assert.ok(js.includes('2000'));
});
