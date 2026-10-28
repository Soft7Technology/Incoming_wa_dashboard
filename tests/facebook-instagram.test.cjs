const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { load, fixture, utils, instagramServiceModule, instagramGraphModule, publishingMediaModule, configure } = require('./facebook-helpers.cjs');
const required = Array.from(instagramServiceModule.instagramPermissions);
const local = !process.env.FACEBOOK_TEST_DATABASE_URL && 'Set FACEBOOK_TEST_DATABASE_URL to isolated local PostgreSQL.';
const dbTest = (name, run) => test(name, { skip: local }, () => instagramFixture(run));

async function instagramFixture(run) {
  await fixture(async context => {
    const { meta, instagramService: service, a } = context;
    meta.grants = [...required];
    let fields = ['leadgen'], posts = 0;
    const page = { id: '20001', name: 'Linked Page', access_token: 'INSTAGRAM_PRIVATE_PAGE_TOKEN', tasks: ['MESSAGING'], instagram_business_account: { id: '50001', username: 'test_business' } };
    meta.call = async (path, token, method = 'GET', params = {}, body) => {
      meta.calls.push({ path, token, method, params, body });
      if (meta.failure) throw meta.failure;
      if (path === 'me/accounts') return { data: [page] };
      if (path === '20001') return { id: '20001', name: page.name, instagram_business_account: page.instagram_business_account };
      if (path.endsWith('/subscribed_apps')) {
        if (method === 'POST') fields = body.subscribed_fields.split(',');
        if (method === 'DELETE') fields = [];
        return method === 'GET' ? { data: [{ id: process.env.FACEBOOK_APP_ID, subscribed_fields: fields }] } : { success: true };
      }
      if (method === 'POST' && path === '20001/messages') { posts++; return { message_id: 'mid-out-' + posts }; }
      if (method === 'POST' && path.endsWith('/replies')) { posts++; return { id: '80002' }; }
      if (method === 'POST') return { success: true };
      if (path === '20001/conversations') { assert.equal(params.platform, 'instagram'); return { data: [{ id: 'thread:70001', updated_time: new Date().toISOString(), participants: { data: [{ id: '50001' }, { id: '60001', username: '<img src=x onerror=alert(1)>' }] } }] }; }
      if (path === 'thread:70001/messages') return { data: [{ id: 'mid-in-1', message: 'Question about my order', from: { id: '60001' }, created_time: new Date().toISOString() }] };
      if (path === '50001/media') return { data: [{ id: '70001', caption: 'Our products', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/example/', timestamp: new Date().toISOString() }] };
      if (path === '70001/comments') return { data: [{ id: '80001', text: 'Is this available?', username: 'customer', hidden: false, timestamp: new Date().toISOString() }] };
      throw new Error('Unexpected Meta path: ' + path);
    };
    async function login(s = a) {
      const login = await service.start(s), state = new URL(login.url).searchParams.get('state');
      return { ...login, state };
    }
    async function connect(s = a) {
      const session = await login(s); assert.equal(await service.callback(session.state, session.browser, 'FIXTURE_CODE', false), 'ready');
      return service.connect(s, session.browser, '20001');
    }
    const webhook = (mid = 'mid-webhook', timestamp = Date.now(), incoming = true) => ({ object: 'instagram', entry: [{ id: '50001', messaging: [{
      sender: { id: incoming ? '60001' : '50001' }, recipient: { id: incoming ? '50001' : '60001' }, timestamp, message: { mid, text: 'Webhook customer message' },
    }] }] });
    await run({ ...context, ig: service, login, connectInstagram: connect, webhook, page, fields: () => fields, posts: () => posts });
  });
}

test('Instagram Facebook Login configuration uses the selected permission family', () => {
  assert.deepEqual(required, ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata']);
  const saved = process.env.INSTAGRAM_LOGIN_CONFIG_ID; delete process.env.INSTAGRAM_LOGIN_CONFIG_ID;
  assert.throws(() => instagramServiceModule.instagramConfig(), /INSTAGRAM_LOGIN_CONFIG_ID/);
  process.env.INSTAGRAM_LOGIN_CONFIG_ID = saved;
});

test('direct Instagram configuration is independent of Facebook app credentials and Login config', () => {
  for (const key of ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_GRAPH_VERSION', 'FACEBOOK_PUBLIC_URL', 'FACEBOOK_LOGIN_CONFIG_ID', 'INSTAGRAM_LOGIN_CONFIG_ID']) delete process.env[key];
  try {
    const c = instagramServiceModule.instagramConfig('instagram');
    assert.equal(c.appId, '10005');
    assert.equal(c.callback, 'https://support.example.test/v1/facebook/instagram/oauth/callback');
    assert.throws(() => instagramServiceModule.instagramConfig('untrusted'), /Choose Instagram or Facebook/);
  } finally { configure(); }
});

test('direct transport exchanges codes and long-lived tokens on Instagram hosts, with safe errors', async () => {
  const calls = [];
  const axios = { request: async request => {
    calls.push(request);
    if (request.url === 'https://api.instagram.com/oauth/access_token') {
      const body = request.data.getBuffer().toString();
      assert.ok(body.includes('unit-test-instagram-secret'));
      assert.ok(body.includes('FIXTURE_AUTH_CODE'));
      return { data: { access_token: 'PRIVATE_SHORT_INSTAGRAM_TOKEN', user_id: '50003', permissions: Array.from(instagramGraphModule.directInstagramPermissions) } };
    }
    if (request.url === 'https://graph.instagram.com/access_token') {
      assert.equal(request.params.grant_type, 'ig_exchange_token');
      return { data: { access_token: 'PRIVATE_LONG_INSTAGRAM_TOKEN', expires_in: 5184000 } };
    }
    if (request.url === 'https://graph.instagram.com/refresh_access_token') return { data: { access_token: 'PRIVATE_REFRESHED_TOKEN', expires_in: 5184000 } };
    assert.equal(request.url, 'https://graph.instagram.com/v26.0/me');
    assert.equal(request.headers.Authorization, 'Bearer PRIVATE_LONG_INSTAGRAM_TOKEN');
    assert.equal(request.params.fields, 'user_id,username');
    assert.equal(request.params.appsecret_proof, undefined);
    return { data: { user_id: '50002', username: 'direct_business' } };
  } };
  const module = load('src/app/services/instagramGraph.service.ts', { axios, '../utils/facebook': utils });
  const graph = new module.InstagramGraph();
  const auth = await graph.authorize('FIXTURE_AUTH_CODE', instagramServiceModule.instagramConfig('instagram').callback);
  assert.equal(auth.userId, '50003'); assert.equal(auth.profile.id, '50002'); assert.equal(auth.token, 'PRIVATE_LONG_INSTAGRAM_TOKEN');
  assert.equal(calls.length, 3); assert.ok(auth.expires.getTime() > Date.now() + 59 * 86400000);
  assert.equal((await graph.refresh(auth.token)).token, 'PRIVATE_REFRESHED_TOKEN');
  assert.ok(calls.every(call => call.maxRedirects === 0 && call.timeout === 15000));
  for (const endpoint of ['https://evil.test/leak', '../me', 'me?access_token=leak']) await assert.rejects(graph.call(endpoint, 'PRIVATE_TOKEN'), /Invalid Instagram API path/);
  axios.request = async () => { throw { response: { data: { error: { code: 190, message: 'PRIVATE_TOKEN_AND_SECRET' } } }, config: { headers: { Authorization: 'Bearer PRIVATE_TOKEN' } } }; };
  await assert.rejects(graph.call('me', 'PRIVATE_TOKEN'), e => e.code === 'TOKEN_EXPIRED' && !e.message.includes('PRIVATE'));
  axios.request = async () => { throw { response: { data: { error: { code: 1, message: 'PRIVATE_UPSTREAM_DETAILS' } } } }; };
  await assert.rejects(graph.call('me/conversations', 'PRIVATE_TOKEN'), e => e.status === 503 && e.code === 'INSTAGRAM_TEMPORARY_ERROR' && !e.message.includes('PRIVATE'));
  axios.request = async () => { throw { response: { data: { error: { code: 100, message: 'PRIVATE_MEDIA_URL' } } } }; };
  await assert.rejects(graph.call('me/media', 'PRIVATE_TOKEN'), e => e.status === 400 && e.code === 'INSTAGRAM_INVALID_REQUEST' && !e.message.includes('PRIVATE'));

});

async function directFixture(run) {
  await instagramFixture(async context => {
    let fields = [];
    const calls = [];
    const direct = {
      grants: Array.from(instagramGraphModule.directInstagramPermissions),
      async authorize() { return { token: 'PRIVATE_DIRECT_INSTAGRAM_TOKEN', userId: '50003', profile: { id: '50002', username: 'direct_business' }, granted: this.grants, expires: new Date(Date.now() + 60 * 86400000), appId: '10005' }; },
      async profile() { return { id: '50002', username: 'direct_business' }; },
      async refresh() { calls.push({ path: 'refresh' }); return { token: 'RENEWED_PRIVATE_INSTAGRAM_TOKEN', expires: new Date(Date.now() + 60 * 86400000) }; },
      async call(path, token, method = 'GET', params = {}, body) {
        calls.push({ path, method, params, body });
        if (path === 'me/subscribed_apps') {
          if (method === 'POST') { fields = body.subscribed_fields.split(','); return { success: true }; }
          // Live Instagram returns a subscription ID distinct from the OAuth client ID.
          return { data: [{ id: '18104391506626516', subscribed_fields: direct.reportedFields || fields }] };
        }
        if (path === '50002/conversations') {
          if (params.limit > 10) throw new utils.FacebookError(503, 'Instagram rejected the expanded conversation batch.');
          return { data: [{ id: 'direct:thread', updated_time: new Date().toISOString(), participants: { data: [{ id: '50002' }, { id: '60002', username: 'customer' }] } }] };
        }
        if (path === 'direct:thread/messages') return { data: [{ id: 'incoming-direct', message: 'Hello', from: { id: '60002' }, created_time: new Date().toISOString() }] };
        if (path === '50002/messages' && method === 'POST') { assert.equal(body.messaging_type, undefined); return { message_id: 'outgoing-direct' }; }
        if (path === '50002/media') return { data: [{ id: '70002', caption: 'Direct post', timestamp: new Date().toISOString() }] };
        if (path === '70002/comments') return { data: [{ id: '80002', text: 'Nice', username: 'customer', timestamp: new Date().toISOString() }] };
        if (path === '80002/replies') return { id: '80003' };
        if (path === '80002' && method === 'POST') return { success: true };
        throw new Error('Unexpected direct path: ' + path);
      },
    };
    context.ig.direct = direct;
    context.meta.call = async () => { throw new Error('Direct login must not call Facebook Graph'); };
    context.meta.authorize = async () => { throw new Error('Direct login must not authorize through Facebook'); };
    async function connectDirect(scope = context.a) {
      const start = await context.ig.start(scope, 'instagram');
      const state = new URL(start.url).searchParams.get('state');
      assert.equal(await context.ig.callback(state, start.browser, 'DIRECT_CODE', false), 'ready');
      return context.ig.connect(scope, start.browser, '50002');
    }
    const directWebhook = () => ({ object: 'instagram', entry: [{ id: '50002', messaging: [{ sender: { id: '60002' }, recipient: { id: '50002' }, timestamp: Date.now(), message: { mid: 'direct-webhook', text: 'Direct DM' } }] }] });
    await run({ ...context, direct, directCalls: calls, connectDirect, directWebhook });
  });
}

test('direct Instagram OAuth, account isolation, inbox, comments and renewal work without a Facebook Page', { skip: local }, () => directFixture(async ({ ig, a, b, database, connectDirect, directCalls }) => {
  const start = await ig.start(a, 'instagram'), url = new URL(start.url), state = url.searchParams.get('state');
  assert.equal(url.hostname, 'www.instagram.com'); assert.equal(url.searchParams.get('client_id'), '10005');
  assert.equal(url.searchParams.get('enable_fb_login'), '0'); assert.equal(url.searchParams.get('config_id'), null);
  assert.equal(url.searchParams.get('scope'), Array.from(instagramGraphModule.directInstagramLoginScopes).join(','));
  await assert.rejects(ig.callback(state, utils.random(), 'CODE', false), /expired/);
  assert.equal(await ig.callback(state, start.browser, 'CODE', false), 'ready');
  await assert.rejects(ig.callback(state, start.browser, 'CODE', false), /already used/);
  const candidates = await ig.candidates(a, start.browser);
  assert.equal(candidates.pages[0].page_id, null); assert.equal(candidates.pages[0].selection_id, '50002');
  assert.ok(!JSON.stringify(candidates).includes('PRIVATE'));
  const account = await ig.connect(a, start.browser, '50002');
  assert.equal(account.page_id, null); assert.equal(account.auth_provider, 'instagram');
  const stored = await database('instagram_accounts').where({ id: account.id }).first();
  assert.equal(stored.facebook_user_id, null); assert.equal(stored.provider_user_id, '50003');
  assert.equal(utils.decrypt(stored.token_ciphertext), 'PRIVATE_DIRECT_INSTAGRAM_TOKEN');
  assert.ok(!JSON.stringify(await ig.accounts(a)).includes('PRIVATE'));
  await assert.rejects(connectDirect(b), /another workspace/);
  await ig.sync(a, account.id, 'conversation');
  const conversation = (await ig.list(a, account.id, 'conversation'))[0];
  await ig.sync(a, account.id, 'message', conversation.id);
  assert.equal((await ig.messages(a, account.id, conversation.id)).can_reply, true);
  assert.equal((await ig.action(a, account.id, conversation.id, 'message', 'Direct reply', crypto.randomUUID())).status, 'confirmed');
  await ig.sync(a, account.id, 'media');
  const media = (await ig.list(a, account.id, 'media'))[0];
  await ig.sync(a, account.id, 'comment', media.id);
  const comment = (await ig.comments(a, account.id, media.id))[0];
  assert.equal((await ig.action(a, account.id, comment.id, 'reply', 'Thanks', crypto.randomUUID())).status, 'confirmed');
  assert.equal((await ig.action(a, account.id, comment.id, 'hide', true, crypto.randomUUID())).status, 'confirmed');
  await database('instagram_accounts').where({ id: account.id }).update({ token_expires_at: new Date(Date.now() + 3 * 86400000), token_refreshed_at: new Date(Date.now() - 2 * 86400000) });
  await ig.sync(a, account.id, 'media');
  assert.equal(directCalls.filter(c => c.path === 'refresh').length, 1);
  assert.equal(utils.decrypt((await database('instagram_accounts').where({ id: account.id }).first()).token_ciphertext), 'RENEWED_PRIVATE_INSTAGRAM_TOKEN');
  await ig.revoke('50003', false, 'facebook');
  assert.equal((await database('instagram_accounts').where({ id: account.id }).first()).status, 'connected');
  await ig.revoke('50003', false, 'instagram');
  assert.equal((await database('instagram_accounts').where({ id: account.id }).first()).token_ciphertext, null);
}));

test('direct Instagram rejects declined scopes, cancellation, changed app and expired selections', { skip: local }, () => directFixture(async ({ ig, a, direct, database, connectDirect }) => {
  const login = async () => { const s = await ig.start(a, 'instagram'); return { ...s, state: new URL(s.url).searchParams.get('state') }; };
  let s = await login(); direct.grants = ['instagram_business_basic'];
  assert.equal(await ig.callback(s.state, s.browser, 'CODE', false), 'failed');
  assert.match((await ig.candidates(a, s.browser)).error, /instagram_business_manage_messages/);
  direct.grants = Array.from(instagramGraphModule.directInstagramPermissions);
  s = await login(); assert.equal(await ig.callback(s.state, s.browser, 'CODE', true), 'failed');
  s = await login(); await database('instagram_oauth_sessions').where({ state_hash: utils.hash(s.state) }).update({ provider_app_id: 'different' });
  assert.equal(await ig.callback(s.state, s.browser, 'CODE', false), 'failed');
  s = await login(); assert.equal(await ig.callback(s.state, s.browser, 'CODE', false), 'ready');
  await database('instagram_oauth_sessions').where({ state_hash: utils.hash(s.state) }).update({ expires_at: new Date(0) });
  await assert.rejects(ig.connect(a, s.browser, '50002'), /fresh/);
  direct.reportedFields = ['messages'];
  await assert.rejects(connectDirect(), /subscription could not be verified/);
  assert.equal((await database('instagram_accounts')).length, 0);
}));

test('direct Instagram HTTP login and webhook signatures are isolated from Facebook and support deletion', { skip: local }, () => directFixture(async context => {
  await httpFixture(context, async base => {
    const headers = { Authorization: 'Bearer INSTAGRAM_TEST_JWT', 'Content-Type': 'application/json' };
    let response = await fetch(base + '/v1/admin/instagram/oauth/start', { method: 'POST', headers, body: '{"provider":"instagram"}' });
    const start = (await response.json()).data, state = new URL(start.authorization_url).searchParams.get('state');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    response = await fetch(base + '/v1/facebook/instagram/oauth/callback?state=' + state + '&code=CODE', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(response.status, 303); assert.match(response.headers.get('location'), /oauth=ready/);
    response = await fetch(base + '/v1/admin/instagram/accounts', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: '{"instagram_id":"50002"}' });
    assert.equal(response.status, 200);
    const endpoint = base + '/v1/facebook/instagram/webhook';
    response = await fetch(endpoint + '?hub.mode=subscribe&hub.verify_token=unit-test-ig-verify&hub.challenge=123');
    assert.equal(await response.text(), '123');
    const body = JSON.stringify(context.directWebhook());
    const signature = secret => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    response = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-Hub-Signature-256': signature(process.env.FACEBOOK_APP_SECRET) }, body }); assert.equal(response.status, 403);
    // A valid Facebook signature cannot deliver events to a direct Instagram account.
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers: { ...headers, 'X-Hub-Signature-256': signature(process.env.FACEBOOK_APP_SECRET) }, body }); assert.equal(response.status, 200);
    assert.equal((await context.database('instagram_records')).length, 0);
    response = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-Hub-Signature-256': signature(process.env.INSTAGRAM_APP_SECRET) }, body }); assert.equal(response.status, 200);
    assert.equal((await context.database('instagram_records').where({ kind: 'message' })).length, 1);
    // Meta can redeliver direct Instagram events to the older shared callback.
    await context.database('instagram_records').delete();
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers: { ...headers, 'X-Hub-Signature-256': signature(process.env.INSTAGRAM_APP_SECRET) }, body }); assert.equal(response.status, 200);
    assert.equal((await context.database('instagram_records').where({ kind: 'message' })).length, 1);
    const pageBody = JSON.stringify({ object: 'page', entry: [] });
    const pageSignature = 'sha256=' + crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(pageBody).digest('hex');
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers: { ...headers, 'X-Hub-Signature-256': pageSignature }, body: pageBody }); assert.equal(response.status, 403);
    response = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-Hub-Signature-256': signature(process.env.INSTAGRAM_APP_SECRET) }, body: body + ' ' }); assert.equal(response.status, 403);
    const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '50003' })).toString('base64url');
    const signed = crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(payload).digest('base64url') + '.' + payload;
    response = await fetch(base + '/v1/facebook/instagram/data-deletion', { method: 'POST', headers, body: JSON.stringify({ signed_request: signed }) }); assert.equal(response.status, 200);
    const confirmation = await response.json(); assert.ok(confirmation.confirmation_code);
    response = await fetch(confirmation.url.replace('https://support.example.test', base)); assert.equal(response.status, 200);
    assert.equal((await context.database('instagram_accounts')).length, 0);
    assert.equal((await context.database('instagram_records')).length, 0);
  });
}));

dbTest('Instagram OAuth is browser-bound and single-use; credentials stay encrypted and scoped', async ({ ig, login, a, b, other, member, database }) => {
  const session = await login();
  assert.equal(new URL(session.url).searchParams.get('config_id'), '10004');
  assert.equal(new URL(session.url).searchParams.get('redirect_uri'), 'https://support.example.test/v1/facebook/instagram/oauth/callback');
  await assert.rejects(ig.callback(session.state, utils.random(), 'CODE', false), /expired/);
  assert.equal(await ig.callback(session.state, session.browser, 'CODE', false), 'ready');
  await assert.rejects(ig.callback(session.state, session.browser, 'CODE', false), /already used/);
  assert.equal((await ig.candidates(b, session.browser)).status, 'none');
  assert.equal(JSON.stringify(await ig.candidates(a, session.browser)).includes('INSTAGRAM_PRIVATE'), false);
  const account = await ig.connect(a, session.browser, '20001');
  const stored = await database('instagram_accounts').first();
  assert.equal(utils.decrypt(stored.token_ciphertext), 'INSTAGRAM_PRIVATE_PAGE_TOKEN');
  assert.equal(JSON.stringify(await ig.accounts(a)).includes('token'), false);
  assert.equal((await ig.accounts(b)).length, 0);
  for (const s of [b, other]) await assert.rejects(ig.messages(s, account.id, crypto.randomUUID()), /not found/);
  await assert.rejects(ig.accounts(member), /Only the account owner/);
  await assert.rejects(ig.accounts({ ...a, reviewPageId: '20001' }), /company owner/);
  await assert.rejects(ig.connect(a, session.browser, '20001'), /fresh/);
});

dbTest('Instagram authorization reports missing grants, cancelled consent, and absent linked accounts', async ({ ig, login, meta, a, page }) => {
  let session = await login(); meta.grants = [...utils.leadPermissions];
  assert.equal(await ig.callback(session.state, session.browser, 'CODE', false), 'failed');
  assert.match((await ig.candidates(a, session.browser)).error, /instagram_manage_messages/);
  session = await login(); assert.equal(await ig.callback(session.state, session.browser, 'CODE', true), 'failed');
  meta.grants = required; delete page.instagram_business_account;
  session = await login(); assert.equal(await ig.callback(session.state, session.browser, 'CODE', false), 'failed');
  assert.match((await ig.candidates(a, session.browser)).error, /No eligible linked/);
});

dbTest('Instagram connection preserves leadgen and prevents another workspace claiming the same Page/account', async ({ ig, connectInstagram, a, b, database, fields, service, leadService }) => {
  const account = await connectInstagram();
  assert.deepEqual(fields().sort(), ['leadgen', 'messages']);
  await assert.rejects(connectInstagram(b), /another workspace/);
  await database('facebook_pages').insert({ company_id: a.companyId, owner_id: a.ownerId, page_id: '20001', name: 'Page', facebook_user_id: '30002', token_ciphertext: utils.encrypt('MESSENGER_TOKEN'), status: 'connected' });
  const messenger = await database('facebook_pages').first();
  await service.disconnect(a, messenger.id);
  assert.deepEqual(fields().sort(), ['leadgen', 'messages']);
  await database('facebook_lead_pages').insert({ company_id: a.companyId, owner_id: a.ownerId, page_id: '20001', name: 'Page', facebook_user_id: '30002', token_ciphertext: utils.encrypt('LEAD_TOKEN'), status: 'connected' });
  const lead = await database('facebook_lead_pages').first();
  await leadService.disconnect(a, lead.id);
  assert.deepEqual(fields().sort(), ['leadgen', 'messages']);
  assert.equal((await ig.accounts(a))[0].id, account.id);
});

dbTest('Instagram reads real Graph conversations and messages; replies obey the customer window and idempotency', async ({ ig, connectInstagram, a, webhook, database, meta, posts }) => {
  const account = await connectInstagram();
  await ig.sync(a, account.id, 'conversation');
  const c = (await ig.list(a, account.id, 'conversation'))[0];
  assert.equal((await ig.messages(a, account.id, c.id)).can_reply, false);
  await ig.sync(a, account.id, 'message', c.id);
  const thread = await ig.messages(a, account.id, c.id); assert.equal(thread.can_reply, true); assert.equal(thread.messages[0].payload.text, 'Question about my order');
  const request = crypto.randomUUID();
  const [first, second] = await Promise.all([ig.action(a, account.id, c.id, 'message', 'Thanks, how can I help?', request), ig.action(a, account.id, c.id, 'message', 'Thanks, how can I help?', request)]);
  assert.equal(first.status, 'confirmed'); assert.ok(['confirmed', 'pending'].includes(second.status)); assert.equal(posts(), 1);
  await assert.rejects(ig.action(a, account.id, c.id, 'message', 'Different text', request), /already used/);
  await ig.receive(webhook('same-event')); await ig.receive(webhook('same-event'));
  assert.equal(Number((await database('instagram_records').where({ account_id: account.id, kind: 'message', remote_id: 'same-event' }).count('* as n').first()).n), 1);
  await database('instagram_records').where({ account_id: account.id, kind: 'message' }).whereRaw("payload->>'incoming' = 'true'").update({ event_at: new Date(Date.now() - 25 * 3600000) });
  await ig.receive(webhook('outgoing-event', Date.now(), false));
  assert.equal((await ig.messages(a, account.id, c.id)).can_reply, false);
  await assert.rejects(ig.action(a, account.id, c.id, 'message', 'Too late', crypto.randomUUID()), /24-hour/);
  assert.equal(posts(), 1);
  await ig.receive(webhook('fresh-event'));
  meta.failure = new Error('SENSITIVE_HTTP_TOKEN'); const uncertain = crypto.randomUUID();
  await assert.rejects(ig.action(a, account.id, c.id, 'message', 'Uncertain', uncertain), e => e.code === 'META_UNCONFIRMED' && !e.message.includes('SENSITIVE'));
  meta.failure = null; assert.equal((await ig.action(a, account.id, c.id, 'message', 'Uncertain', uncertain)).status, 'unconfirmed'); assert.equal(posts(), 1);
});

dbTest('Instagram comment replies and hide/unhide target only imported account-owned comments', async ({ ig, connectInstagram, a, b, database, meta }) => {
  const account = await connectInstagram(); await ig.sync(a, account.id, 'media');
  const media = (await ig.list(a, account.id, 'media'))[0]; await ig.sync(a, account.id, 'comment', media.id);
  const comment = (await ig.comments(a, account.id, media.id))[0];
  assert.equal(comment.payload.text, 'Is this available?');
  assert.equal((await ig.action(a, account.id, comment.id, 'reply', 'Yes, it is available.', crypto.randomUUID())).status, 'confirmed');
  await ig.action(a, account.id, comment.id, 'hide', true, crypto.randomUUID());
  assert.equal((await ig.comments(a, account.id, media.id))[0].payload.hidden, true);
  await ig.action(a, account.id, comment.id, 'hide', false, crypto.randomUUID());
  assert.equal((await ig.comments(a, account.id, media.id))[0].payload.hidden, false);
  await assert.rejects(ig.action(b, account.id, comment.id, 'reply', 'Wrong owner', crypto.randomUUID()), /not found/);
  const before = meta.calls.length; await assert.rejects(ig.action(a, account.id, crypto.randomUUID(), 'reply', 'Unknown comment', crypto.randomUUID()), /not found/); assert.equal(meta.calls.length, before);
  await ig.receive({ object: 'instagram', entry: [{ id: '50001', changes: [{ field: 'comments', value: { id: '80003', media: { id: '70001' }, text: 'New webhook comment', from: { username: 'another_customer' } } }] }] });
  assert.equal((await ig.comments(a, account.id, media.id)).length, 2);
  await ig.disconnect(a, account.id); await ig.receive({ object: 'instagram', entry: [{ id: '50001', changes: [{ field: 'comments', value: { id: '80004', media: { id: '70001' }, text: 'Ignored' } }] }] });
  assert.equal((await ig.comments(a, account.id, media.id)).length, 2);
  await assert.rejects(ig.action(a, account.id, comment.id, 'hide', true, crypto.randomUUID()), /Reconnect/);
  await ig.disconnect(a, account.id, true);
  assert.equal((await database('instagram_records')).length, 0); assert.equal((await database('instagram_actions')).length, 0);
});

dbTest('Instagram Graph pagination passes only cursors, checks child ownership and revalidates active authorization', async ({ ig, connectInstagram, a, meta, database }) => {
  const account = await connectInstagram();
  const original = meta.call;
  meta.call = async (path, token, method, params) => {
    assert.equal(path, '50001/media'); assert.equal(params.after, 'safe-cursor');
    return { data: [], paging: { next: 'https://attacker.example/token', cursors: { after: 'next-cursor' } } };
  };
  assert.equal((await ig.sync(a, account.id, 'media', undefined, 'safe-cursor')).next_cursor, 'next-cursor');
  await assert.rejects(ig.sync(a, account.id, 'media', undefined, '\ninvalid'), /Invalid pagination/);
  meta.call = original;
  await database('instagram_accounts').where({ id: account.id }).update({ data_access_expires_at: new Date(1) });
  await assert.rejects(ig.sync(a, account.id, 'media'), /expired/);
  assert.equal((await ig.accounts(a))[0].status, 'reconnect_required');
});

dbTest('Instagram serializes an in-flight send with disconnection and erasure', async ({ ig, connectInstagram, a, meta, webhook, database }) => {
  const account = await connectInstagram(); await ig.receive(webhook());
  const conversation = (await ig.list(a, account.id, 'conversation'))[0];
  const original = meta.call; let release;
  const called = new Promise(resolve => { meta.call = async (...args) => {
    if (args[0] === '20001/messages' && args[2] === 'POST') {
      await new Promise(done => { release = done; resolve(); });
    }
    return original(...args);
  }; });
  const send = ig.action(a, account.id, conversation.id, 'message', 'Concurrent reply', crypto.randomUUID());
  await called;
  let disconnected = false;
  const erase = ig.disconnect(a, account.id, true).then(() => { disconnected = true; });
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(disconnected, false);
  release(); assert.equal((await send).status, 'confirmed'); await erase;
  assert.equal((await database('instagram_records')).length, 0); assert.equal((await database('instagram_actions')).length, 0);
});

function controllers(context) {
  const messenger = load('src/app/http/controllers/facebookMessenger.controller.ts', {
    '../../services/facebookMessenger.service': { __esModule: true, default: context.service },
    '../../services/facebookLeads.service': { __esModule: true, default: context.leadService },
    '../../services/instagram.service': { __esModule: true, default: context.ig }, '../../utils/facebook': utils,
  });
  const instagram = load('src/app/http/controllers/instagram.controller.ts', {
    '../../services/instagram.service': { ...instagramServiceModule, __esModule: true, default: context.ig },
    '../../services/instagramGraph.service': instagramGraphModule,
    '../../services/instagramPublishing.service': { __esModule: true, default: context.publishingService },
    '../../utils/instagramPublishingMedia': publishingMediaModule,
    './facebookMessenger.controller': messenger, '../../utils/facebook': utils,
  });
  return { messenger, instagram };
}

async function httpFixture(context, run) {
  const { messenger, instagram } = controllers(context);
  const deps = { '../app/http/controllers/facebookMessenger.controller': messenger, '../app/http/controllers/facebookContent.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } }, '../app/http/controllers/instagram.controller': instagram,
    '../app/http/controllers/facebookLeads.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } },
    './facebookLoginTest.route': express.Router(), './facebookReviewLogin.route': express.Router() };
  const app = express(); app.use(express.json({ verify: (req, _res, body) => { req.rawBody = body; } }));
  app.post('/v1/auth/login', (_req, res) => res.json({ success: true, data: { token: 'INSTAGRAM_TEST_JWT' } }));
  app.use('/v1/admin/instagram', (req, res, next) => {
    if (req.headers.authorization !== 'Bearer INSTAGRAM_TEST_JWT') return res.status(401).json({ success: false });
    Object.assign(req, context.a); next();
  }, load('src/routes/instagram.route.ts', deps).default);
  // Public browser fixture uses the selected test owner; tenant/cookie checks have their own tests.
  deps['./publicMetaWorkspace.route'] = express.Router();
  app.post('/v1/facebook/session', (_req, res) => res.json({ success: true, data: { ready: true } }));
  app.use('/v1/facebook/api/instagram', (req, _res, next) => { Object.assign(req, context.a); next(); },
    load('src/routes/instagram.route.ts', deps).default);
  app.use('/v1/facebook', load('src/routes/facebookPublic.route.ts', deps).default);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

dbTest('Instagram HTTP routes protect account data, bind OAuth cookies, check webhook signatures and perform signed deletion', async context => {
  await httpFixture(context, async base => {
    const { ig, a, webhook, connectInstagram, database } = context;
    const auth = { Authorization: 'Bearer INSTAGRAM_TEST_JWT', 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/v1/admin/instagram/accounts')).status, 401);
    let response = await fetch(base + '/v1/admin/instagram/oauth/start', { method: 'POST', headers: auth, body: '{}' });
    assert.match(response.headers.get('set-cookie'), /ig_browser=.*HttpOnly.*Secure.*SameSite=Lax/);
    const start = (await response.json()).data, state = new URL(start.authorization_url).searchParams.get('state');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    response = await fetch(base + '/v1/facebook/instagram/oauth/callback?state=' + state + '&code=TEST_CODE', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/v1/facebook/instagram#oauth=ready');
    response = await fetch(base + '/v1/admin/instagram/accounts', { method: 'POST', headers: { ...auth, Cookie: cookie }, body: '{"page_id":"20001"}' });
    assert.equal(response.status, 200); assert.equal(JSON.stringify(await response.json()).includes('INSTAGRAM_PRIVATE'), false);
    const body = JSON.stringify(webhook());
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(body).digest('hex');
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers: { ...auth, 'X-Hub-Signature-256': signature }, body }); assert.equal(response.status, 200);
    response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', headers: { ...auth, 'X-Hub-Signature-256': signature }, body: body + ' ' }); assert.equal(response.status, 403);
    assert.equal((await database('instagram_records').where({ kind: 'message' })).length, 1);
    const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '30001' })).toString('base64url');
    const signed = crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(payload).digest('base64url') + '.' + payload;
    response = await fetch(base + '/v1/facebook/deauthorize', { method: 'POST', headers: auth, body: JSON.stringify({ signed_request: signed }) }); assert.equal(response.status, 200);
    assert.equal((await database('instagram_accounts').first()).token_ciphertext, null);
    response = await fetch(base + '/v1/facebook/data-deletion', { method: 'POST', headers: auth, body: JSON.stringify({ signed_request: signed }) }); assert.equal(response.status, 200);
    assert.equal((await database('instagram_accounts')).length, 0); assert.equal((await database('instagram_records')).length, 0);
    response = await fetch(base + '/v1/facebook/instagram'); assert.match(await response.text(), /Instagram Inbox/);
  });
});

test('Instagram browser reads and replies to DMs and moderates comments without rendering injected markup', {
  skip: local || !process.env.FACEBOOK_TEST_CHROME && 'Set FACEBOOK_TEST_CHROME for browser testing.', timeout: 60000,
}, () => instagramFixture(async context => {
  const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  await context.connectInstagram();
  await httpFixture(context, async base => {
    const profile = path.resolve('.facebook-test-runtime/instagram-chrome-' + crypto.randomUUID()); fs.mkdirSync(profile, { recursive: true });
    const chrome = spawn(process.env.FACEBOOK_TEST_CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let socket; chrome.on('error', () => {});
    try {
      const portFile = path.join(profile, 'DevToolsActivePort');
      for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await pause(100);
      const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
      const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page');
      socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      let seq = 0; const waiting = new Map(), errors = [];
      socket.addEventListener('message', event => { const msg = JSON.parse(event.data); if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params); const pending = waiting.get(msg.id); if (pending) { waiting.delete(msg.id); clearTimeout(pending.timeout); msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result); } });
      const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq, timeout = setTimeout(() => { waiting.delete(id); reject(new Error('Chrome timed out: ' + method)); }, 5000); waiting.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params })); });
      const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
      const waitFor = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(100); } throw new Error('Browser condition failed: ' + expression + ' Notice: ' + await evaluate("document.getElementById('notice').textContent")); };
      await call('Runtime.enable'); await call('Page.enable'); await call('Page.navigate', { url: base + '/v1/facebook/instagram' });
      await waitFor("!document.getElementById('workspace').hidden && typeof api === 'function'");
      await waitFor("!document.getElementById('workspace').hidden && document.getElementById('accounts').innerText.includes('test_business')");
      await evaluate("document.querySelector('#accounts button').click()");
      await waitFor("!document.getElementById('account-workspace').hidden");
      assert.equal(await evaluate("document.getElementById('profile-username').textContent"), '@test_business');
      assert.equal(await evaluate("document.getElementById('profile-id').textContent"), '50001');
      assert.equal(await evaluate("document.getElementById('profile-link').href"), 'https://www.instagram.com/test_business/');
      await evaluate("document.getElementById('refresh-profile').click()");
      await waitFor("document.getElementById('notice').textContent === 'Instagram profile refreshed.'");
      await evaluate("document.getElementById('refresh-conversations').click()");
      await waitFor("Boolean(document.querySelector('#conversations button'))");
      assert.equal(await evaluate("document.querySelector('#conversations img') === null"), true);
      await evaluate("document.querySelector('#conversations button').click()");
      await waitFor("document.getElementById('messages').innerText.includes('Question about my order') && !document.getElementById('send-message').disabled");
      await evaluate("document.getElementById('message-text').value='Thanks for your message';document.getElementById('reply-form').requestSubmit()");
      await waitFor("document.getElementById('messages').innerText.includes('Thanks for your message')");
      await evaluate("document.getElementById('refresh-media').click()");
      await waitFor("Boolean(document.querySelector('#media button'))"); await evaluate("document.querySelector('#media button').click()");
      await waitFor("document.getElementById('comments').innerText.includes('Is this available?')");
      await evaluate("document.querySelector('#comments textarea').value='Yes, available';document.querySelector('#comments form').requestSubmit()");
      await waitFor("document.getElementById('comments').innerText.includes('Reply published on Instagram.')");
      await evaluate("Array.from(document.querySelectorAll('#comments button')).find(b=>b.textContent==='Hide comment').click()");
      await waitFor("document.getElementById('comments').innerText.includes('Unhide comment')");
      // Exercise the direct publishing composer using a controlled professional account.
      const publishingAccount = (await context.database('instagram_accounts').first()).id;
      await context.database('instagram_accounts').where({ id: publishingAccount }).update({
        auth_provider: 'instagram', provider_app_id: '10005', instagram_id: '50002',
        token_expires_at: new Date(Date.now() + 60 * 86400000), token_refreshed_at: new Date(),
        granted_permissions: JSON.stringify(Array.from(instagramGraphModule.directInstagramLoginScopes)),
      });
      const publisher = publishingMock(context);
      await evaluate("accounts()");
      await evaluate("document.querySelector('#accounts button').click()");
      await waitFor("!document.getElementById('publish-fields').disabled");
      await evaluate("document.getElementById('publish-source').value='url';document.getElementById('publish-source').dispatchEvent(new Event('change'));document.getElementById('publish-url').value='https://media.example.test/photo.jpg';document.getElementById('publish-caption').value='Browser publishing test';document.getElementById('publish-form').requestSubmit()");
      await waitFor("document.getElementById('publications').innerText.includes('ready') && document.getElementById('publications').innerText.includes('Browser publishing test')");
      assert.equal(publisher.publishes(), 0);
      await evaluate("Array.from(document.querySelectorAll('#publications button')).find(b=>b.textContent==='Publish to Instagram').click()");
      await waitFor("document.getElementById('publications').innerText.includes('View published post')");
      assert.equal(publisher.publishes(), 1);
      assert.equal(await evaluate("document.querySelector('#publications a').href"), 'https://www.instagram.com/p/publishing-test/');
      assert.equal(errors.length, 0, JSON.stringify(errors));
      const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.resolve('.facebook-test-runtime/browser-instagram.png'), Buffer.from(screenshot.data, 'base64'));
      await call('Page.navigate', { url: base + '/v1/facebook/instagram' });
      await waitFor("!document.getElementById('workspace').hidden && !document.getElementById('connect').disabled");
      assert.equal(await evaluate("document.getElementById('connect').textContent"), 'Connect with Instagram');
      assert.equal(await evaluate("document.getElementById('connect-facebook').disabled"), false);
      let instagramAuthorization;
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Fetch.requestPaused') {
          instagramAuthorization = new URL(message.params.request.url);
          call('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<h1>Instagram authorization fixture</h1>').toString('base64') }).catch(() => {});
        }
      });
      await call('Fetch.enable', { patterns: [{ urlPattern: 'https://www.instagram.com/*', requestStage: 'Request' }] });
      await evaluate("document.getElementById('connect').click()");
      for (let i = 0; i < 100 && !instagramAuthorization; i++) await pause(100);
      assert.ok(instagramAuthorization);
      assert.equal(instagramAuthorization.hostname, 'www.instagram.com');
      assert.equal(instagramAuthorization.searchParams.get('client_id'), '10005');
      assert.equal(instagramAuthorization.searchParams.get('enable_fb_login'), '0');
      assert.ok(instagramAuthorization.searchParams.get('scope').includes('instagram_business_manage_messages'));
    } finally { if (socket) socket.close(); chrome.kill(); }
  });
}));


function publishingMock(context) {
  let status = 'FINISHED', creates = 0, publishes = 0, publishFailure;
  const calls = [];
  context.publishingService.meta = { async call(path, token, method = 'GET', params = {}, body) {
    calls.push({ path, method, params, body });
    if (path === '50002/media' && method === 'POST') { creates++; return { id: '90001' }; }
    if (path === '90001') return { status_code: status };
    if (path === '50002/media_publish' && method === 'POST') {
      publishes++; if (publishFailure) throw publishFailure;
      return { id: '90002' };
    }
    if (path === '90002') return { id: '90002', caption: 'Published caption', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/publishing-test/' };
    throw new Error('Unexpected publishing request: ' + path);
  } };
  return { calls, creates: () => creates, publishes: () => publishes,
    status: value => { status = value; }, failure: value => { publishFailure = value; } };
}
async function publishingFixture(run) {
  await directFixture(async context => {
    context.direct.grants = Array.from(instagramGraphModule.directInstagramLoginScopes);
    const account = await context.connectDirect();
    const mock = publishingMock(context);
    const draft = (extra = {}) => ({ client_request_id: crypto.randomUUID(), kind: 'IMAGE', media_url: 'https://media.example.test/photo.jpg', caption: 'A photo for our customers', ...extra });
    await run({ ...context, account, mock, draft, publishing: context.publishingService });
  });
}
const publishingTest = (name, run) => test(name, { skip: local }, () => publishingFixture(run));

publishingTest('Instagram prepares a photo, publishes once under concurrent clicks, and stores the published post for comments', async ({ publishing, a, account, mock, draft, ig, database }) => {
  const input = draft();
  const prepared = await publishing.create(a, account.id, input);
  assert.equal(prepared.status, 'ready'); assert.equal(mock.publishes(), 0);
  assert.equal((await publishing.create(a, account.id, input)).id, prepared.id);
  assert.equal(mock.creates(), 1);
  await assert.rejects(publishing.create(a, account.id, { ...input, caption: 'Changed caption' }), e => e.status === 409);
  const results = await Promise.all([publishing.publish(a, account.id, prepared.id), publishing.publish(a, account.id, prepared.id)]);
  assert.ok(results.every(row => ['published', 'publishing'].includes(row.status)));
  assert.equal(mock.publishes(), 1);
  const again = await publishing.publish(a, account.id, prepared.id);
  assert.equal(again.status, 'published'); assert.equal(again.media_id, '90002');
  assert.equal(again.permalink, 'https://www.instagram.com/p/publishing-test/'); assert.equal(mock.publishes(), 1);
  assert.equal((await ig.list(a, account.id, 'media'))[0].remote_id, '90002');
  assert.ok(!JSON.stringify(await publishing.list(a, account.id)).includes('PRIVATE'));
  assert.equal((await database('instagram_accounts').where({ id: account.id }).first()).granted_permissions.includes('instagram_business_content_publish'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(mock.calls.find(c => c.path === '50002/media' && c.method === 'POST').body)), { caption: input.caption, image_url: input.media_url });
});

publishingTest('Instagram Reels wait for processing and transmit video URL and share-to-feed choice', async ({ publishing, a, account, mock, draft }) => {
  mock.status('IN_PROGRESS');
  const row = await publishing.create(a, account.id, draft({ kind: 'REELS', media_url: 'https://media.example.test/reel.mp4', share_to_feed: false }));
  assert.equal(row.status, 'processing');
  await assert.rejects(publishing.publish(a, account.id, row.id), e => e.status === 409); assert.equal(mock.publishes(), 0);
  const body = mock.calls.find(c => c.path === '50002/media').body;
  assert.equal(body.media_type, 'REELS'); assert.equal(body.share_to_feed, false); assert.ok(body.video_url.endsWith('.mp4')); assert.equal(body.image_url, undefined);
  mock.status('FINISHED'); assert.equal((await publishing.refresh(a, account.id, row.id)).status, 'ready');
  assert.equal((await publishing.publish(a, account.id, row.id)).status, 'published');
  const expired = await publishing.create(a, account.id, draft()); mock.status('EXPIRED');
  assert.equal((await publishing.refresh(a, account.id, expired.id)).status, 'failed');
});

publishingTest('Instagram preserves uncertain publication outcomes without sending a duplicate', async ({ publishing, a, account, mock, draft }) => {
  const row = await publishing.create(a, account.id, draft());
  mock.failure(new utils.FacebookError(502, 'PRIVATE_UPSTREAM_DETAILS'));
  const result = await publishing.publish(a, account.id, row.id);
  assert.equal(result.status, 'unconfirmed'); assert.ok(!result.error.includes('PRIVATE'));
  assert.equal((await publishing.publish(a, account.id, row.id)).status, 'unconfirmed'); assert.equal(mock.publishes(), 1);
  mock.status('PUBLISHED');
  assert.equal((await publishing.refresh(a, account.id, row.id)).status, 'published');
  assert.equal(mock.publishes(), 1);
});

publishingTest('Instagram publishing enforces grants, workspace ownership, account status and media validation', async ({ publishing, a, b, other, account, mock, draft, database }) => {
  assert.equal((await publishing.settings(a, account.id)).allowed, true);
  await assert.rejects(publishing.create(b, account.id, draft()), e => e.status === 404);
  await assert.rejects(publishing.create(other, account.id, draft()), e => e.status === 404);
  for (const url of ['http://media.example.test/a.jpg', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://localhost/a', 'https://user:password@example.test/a'])
    await assert.rejects(publishing.create(a, account.id, draft({ media_url: url })), e => e.status === 400);
  await assert.rejects(publishing.create(a, account.id, draft({ caption: 'a'.repeat(2201) })), e => e.status === 400);
  await assert.rejects(publishing.create(a, account.id, draft({ kind: 'CAROUSEL' })), e => e.status === 400);
  assert.equal(mock.creates(), 0);
  await database('instagram_accounts').where({ id: account.id }).update({ granted_permissions: JSON.stringify(Array.from(instagramGraphModule.directInstagramPermissions)) });
  assert.equal((await publishing.settings(a, account.id)).allowed, false);
  await assert.rejects(publishing.create(a, account.id, draft()), e => e.status === 403 && e.code === 'PUBLISHING_PERMISSION_REQUIRED');
  await database('instagram_accounts').where({ id: account.id }).update({ granted_permissions: null, auth_provider: 'facebook' });
  await assert.rejects(publishing.create(a, account.id, draft()), e => e.status === 409);
});

publishingTest('Instagram publishing HTTP uploads validate file contents, serve expiring media and protect publishing operations', async context => {
  const { publishing, a, b, account, database, draft } = context;
  const fs = require('node:fs'), path = require('node:path');
  const savedRoot = process.env.INSTAGRAM_PUBLISH_UPLOAD_DIR;
  process.env.INSTAGRAM_PUBLISH_UPLOAD_DIR = path.resolve('.facebook-test-runtime/.publishing-' + crypto.randomUUID());
  const root = process.env.INSTAGRAM_PUBLISH_UPLOAD_DIR;
  try {
    await httpFixture(context, async base => {
      const endpoint = base + '/v1/admin/instagram/accounts/' + account.id;
      const auth = { Authorization: 'Bearer INSTAGRAM_TEST_JWT' }, json = { ...auth, 'Content-Type': 'application/json' };
      assert.equal((await fetch(endpoint + '/publications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft()) })).status, 401);
      const upload = async (bytes, mime = 'image/jpeg') => {
        const form = new FormData(); form.append('file', new Blob([bytes], { type: mime }), 'photo.jpg');
        return fetch(endpoint + '/publishing/uploads', { method: 'POST', headers: auth, body: form });
      };
      let response = await upload(Buffer.from('not a real image')); assert.equal(response.status, 400);
      assert.equal(fs.readdirSync(root).length, 0);
      response = await upload(Buffer.from([255,216,255,224,0,1,2,3])); assert.equal(response.status, 200);
      const asset = (await response.json()).data;
      // An upload cannot be used by another connected account, even within the same workspace.
      const stored = await database('instagram_accounts').where({ id: account.id }).first();
      const otherAccountId = crypto.randomUUID();
      await database('instagram_accounts').insert({ ...stored, id: otherAccountId, instagram_id: '50004', granted_permissions: JSON.stringify(stored.granted_permissions) });
      await assert.rejects(publishing.create(a, otherAccountId, draft({ asset_id: asset.asset_id })), e => e.status === 400);
      const assetEndpoint = base + new URL(asset.media_url).pathname;
      response = await fetch(assetEndpoint); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.arrayBuffer()).byteLength, 8);
      assert.equal((await fetch(assetEndpoint, { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(assetEndpoint, { headers: { Range: 'bytes=0-2' } })).status, 206);
      assert.equal((await fetch(assetEndpoint + 'x')).status, 404);
      response = await fetch(endpoint + '/publications', { method: 'POST', headers: json, body: JSON.stringify(draft({ asset_id: asset.asset_id })) }); assert.equal(response.status, 200);
      assert.equal((await response.json()).data.status, 'ready');
      await database('instagram_publish_assets').where({ id: asset.asset_id }).update({ expires_at: new Date(1) });
      assert.equal((await fetch(assetEndpoint)).status, 404);
      await assert.rejects(publishing.create(a, account.id, draft({ asset_id: asset.asset_id })), e => e.status === 400);
      await database('instagram_accounts').where({ id: account.id }).update({ status: 'disconnected' });
      response = await upload(Buffer.from([255,216,255])); assert.equal(response.status, 409); assert.equal(fs.readdirSync(root).length, 1);
      await context.ig.disconnect(a, account.id, true);
      assert.equal((await fetch(assetEndpoint)).status, 404);
      assert.equal((await database('instagram_publications').where({ account_id: account.id })).length, 0);

    });
  } finally {
    for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) await publishingMediaModule.removePublishingMedia(name);
    if (savedRoot === undefined) delete process.env.INSTAGRAM_PUBLISH_UPLOAD_DIR; else process.env.INSTAGRAM_PUBLISH_UPLOAD_DIR = savedRoot;
  }
});

test('Instagram profile refresh verifies the connected account, updates its username and isolates owners', { skip: local }, () => directFixture(async context => {
  const { ig, a, b, other, direct, database } = context;
  const account = await context.connectDirect();
  let reads = 0;
  direct.profile = async token => { reads++; assert.equal(token, 'PRIVATE_DIRECT_INSTAGRAM_TOKEN'); return { id: '50002', username: 'renamed_business' }; };
  const profile = await ig.syncProfile(a, account.id);
  assert.equal(profile.instagram_id, '50002'); assert.equal(profile.username, 'renamed_business');
  assert.equal(profile.token_ciphertext, undefined); assert.equal(profile.provider_user_id, undefined);
  for (const scope of [b, other]) await assert.rejects(ig.syncProfile(scope, account.id), e => e.status === 404);
  assert.equal(reads, 1);
  direct.profile = async () => ({ id: '50009', username: 'wrong_account' });
  await assert.rejects(ig.syncProfile(a, account.id), e => e.status === 409);
  assert.equal((await database('instagram_accounts').where({ id: account.id }).first()).username, 'renamed_business');
  direct.profile = async () => ({ id: '50002', username: 'http_business' });
  await httpFixture(context, async base => {
    const url = base + '/v1/admin/instagram/accounts/' + account.id + '/profile/sync';
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer INSTAGRAM_TEST_JWT' } });
    assert.equal(response.status, 200); const data = (await response.json()).data;
    assert.equal(data.username, 'http_business'); assert.equal(data.instagram_id, '50002');
    assert.ok(!JSON.stringify(data).includes('PRIVATE'));
  });
  await ig.disconnect(a, account.id);
  await assert.rejects(ig.syncProfile(a, account.id), e => e.status === 409);
}));
