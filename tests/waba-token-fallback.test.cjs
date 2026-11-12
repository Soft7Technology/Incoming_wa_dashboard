const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const { loadSource } = require('./helpers/background-database.cjs');
class HttpError extends Error {
  constructor({ message, details }) { super(message); this.details = details; }
}
const { CustomError } = loadSource('library/surefy/src/exceptions/CustomError.ts');
const rejection = (code, subcode) => ({ response: { status: 400, data: { error: { code, error_subcode: subcode } } } });

function fixture(options = {}) {
  const env = { META_API_VERSION: 'v23.0', META_ACCESS_TOKEN: 'primary-token', META_APP_ID: '111', META_APP_SECRET: 'primary-secret',
    META_NEW_APP_ACCESS_TOKEN: 'secondary-token', META_NEW_APP_ID: '222', META_NEW_APP_SECRET: 'secondary-secret',
    WABA_WEBHOOK_CALLBACK_URL: 'https://api.example/v1/webhooks/meta',
    WABA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), ...options.env };
  const utils = loadSource('src/app/utils/wabaOnboarding.ts', { crypto,
    '@surefy/exceptions/CustomError': { CustomError }, '@surefy/exceptions/HTTP400Error': HttpError }, { process: { env } });
  const calls = [], logs = [], agents = [];
  const axios = {
    create(config) {
      agents.push(config.httpsAgent);
      if (options.realAxios) return require('axios').create({ ...config, adapter: async request => {
        calls.push(request);
        const data = await options.respond(request);
        return { data, config: request, headers: {}, status: 200, statusText: 'OK' };
      } });
      let before, rejected;
      async function request(method, url, data, extra = {}) {
        const headers = { ...config.headers, set(key, value) { this[key] = value; } };
        const request = { ...extra, method, url, data, headers };
        await before?.(request);
        calls.push(request);
        try {
          if (options.respond) return { data: await options.respond(request) };
          if (headers.Authorization === 'Bearer primary-token') throw rejection(190);
          return { data: method === 'post' ? { success: true } : { id: '123456' } };
        } catch (error) { if (rejected) return rejected(error); throw error; }
      }
      return { interceptors: { request: { use(fn) { before = fn; } }, response: { use(_ok, fail) { rejected = fail; } } },
        get: (url, extra) => request('get', url, undefined, extra),
        delete: (url, extra) => request('delete', url, undefined, extra),
        post: (url, data, extra) => request('post', url, data, extra) };
    },
    async get(url, config) {
      calls.push({ url, ...config });
      if (options.directGet) return options.directGet(url, config);
      return { data: { data: [{ object: 'whatsapp_business_account', active: true,
        callback_url: options.callback || env.WABA_WEBHOOK_CALLBACK_URL,
        fields: options.fields || ['messages', 'account_update'] }] } };
    },
    async post(url, data, config) {
      calls.push({ url, data, ...config });
      return options.directPost(url, data, config);
    },
  };
  const service = loadSource('src/app/services/meta.service.ts', { axios, crypto, https,
    '../utils/wabaOnboarding': utils,
    '../utils/campaignPhone': { campaignRecipientNumber: value => value }, '../utils/importPhone': {},
    '@surefy/exceptions/HTTP500Error': HttpError, '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/config/firebase.config': options.firebase || {}, '../models/activityLogs.model': {},
    ...(options.dependencies || {}),
    '../utils/metaSendError': loadSource('src/app/utils/metaSendError.ts'),
    './wabaCredentials.service': { forResource: async () => options.resourceToken || null },
  }, { process: { env }, console: { error: (...args) => logs.push(args), log() {} } }).default;
  return { service, calls, logs, env, utils, close: () => agents.forEach(agent => agent.destroy()) };
}

test('onboarding retries once with the optional token and the matching app secret', async () => {
  const h = fixture();
  try {
    const result = await h.service.withOnboardingTokenFallback(null, async (client, secondary) => {
      const data = await client.getWabaDetails('123456'); return { data, secondary };
    });
    assert.equal(result.secondary, true);
    assert.deepEqual(h.calls.map(c => c.headers.Authorization), ['Bearer primary-token', 'Bearer secondary-token']);
    assert.equal(h.calls[0].params.appsecret_proof, undefined, 'preserve legacy primary authentication');
    assert.equal(h.calls[1].params.appsecret_proof, crypto.createHmac('sha256', 'secondary-secret').update('secondary-token').digest('hex'));
    assert.ok(!JSON.stringify(h.logs).includes('secondary-token'));
  } finally { h.close(); }
});

test('primary success never calls the optional app', async () => {
  const h = fixture({ respond: async () => ({ id: '123456' }) });
  try {
    await h.service.withOnboardingTokenFallback(null, client => client.getWabaDetails('123456'));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].headers.Authorization, 'Bearer primary-token');
  } finally { h.close(); }
});

test('account onboarding pins old accounts to primary and starts new accounts on secondary without fallback', async () => {
  for (const [saved, isNew, expected] of [[null, false, 'primary-token'], [null, true, 'secondary-token'],
    ['secondary-token', false, 'secondary-token'], ['customer-token', false, 'customer-token']]) {
    const h = fixture({ respond: async () => { throw rejection(190); } });
    try {
      await assert.rejects(h.service.withAccountToken(saved, isNew, c => c.getWabaDetails('123456')));
      assert.deepEqual(h.calls.map(c => c.headers.Authorization), ['Bearer ' + expected]);
      if (expected === 'primary-token') assert.equal(h.calls[0].params?.appsecret_proof, undefined);
    } finally { h.close(); }
  }
  const h = fixture({ env: { META_NEW_APP_ACCESS_TOKEN: '' } });
  try {
    await assert.rejects(h.service.withAccountToken(null, true, c => c.getWabaDetails('123456')), e => e.code === 'WABA_CREDENTIAL_UNAVAILABLE');
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test('concurrent onboarding keeps each WABA on its own selected token', async () => {
  const h = fixture({ respond: async r => {
    if (r.url === '/123456' && r.headers.Authorization === 'Bearer primary-token') throw rejection(190);
    return r.method === 'post' ? { success: true } : { id: r.url.slice(1) };
  } });
  try {
    await Promise.all(['123456', '654321'].map(id => h.service.withOnboardingTokenFallback(null, async client => {
      await client.getWabaDetails(id);
      await client.subscribeToWebhooks(id);
    })));
    const posts = h.calls.filter(c => c.method === 'post');
    assert.equal(posts.find(c => c.url === '/123456/subscribed_apps').headers.Authorization, 'Bearer secondary-token');
    assert.equal(posts.find(c => c.url === '/654321/subscribed_apps').headers.Authorization, 'Bearer primary-token');
  } finally { h.close(); }
});

test('no fallback for absent/duplicate tokens, saved customer credentials, bans, invalid input, rate limits or timeouts', async () => {
  const cases = [
    { env: { META_NEW_APP_ACCESS_TOKEN: '' } }, { env: { META_NEW_APP_ACCESS_TOKEN: 'primary-token' } },
    { savedToken: 'customer-token', respond: async () => { throw rejection(190); } },
    ...[131031, 131048, 131049, 4, 100].map(code => ({ respond: async () => { throw rejection(code); } })),
    { respond: async () => { throw { code: 'ECONNABORTED' }; } },
    { respond: async () => { throw { response: { status: 503, data: {} } }; } },
  ];
  for (const options of cases) {
    const h = fixture(options);
    try {
      await assert.rejects(h.service.withOnboardingTokenFallback(options.savedToken || null, client => client.getWabaDetails('123456')));
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
});

test('permission failures and inaccessible-object subcode permit exactly one retry, including when both tokens fail', async () => {
  for (const [code, subcode] of [[10], [200], [294], [100, 33], [190]]) {
    const h = fixture({ respond: async () => { throw rejection(code, subcode); } });
    try {
      await assert.rejects(h.service.withOnboardingTokenFallback(null, client => client.getWabaDetails('123456')));
      assert.equal(h.calls.length, 2);
    } finally { h.close(); }
  }
});

test('a successful webhook subscription pins the app even if a later operation rejects authorization', async () => {
  const h = fixture({ respond: async r => { if (r.method === 'post') return { success: true }; throw rejection(200); } });
  try {
    await assert.rejects(h.service.withOnboardingTokenFallback(null, async client => {
      await client.subscribeToWebhooks('123456'); await client.getTemplates('123456');
    }));
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(c => c.headers.Authorization === 'Bearer primary-token'));
  } finally { h.close(); }
});

test('a denied repeated subscription succeeds only after confirming the selected app with the same token', async () => {
  const denied = { response: { status: 403, data: { error: { code: 200 } } } };
  const h = fixture({ respond: async r => {
    if (r.method === 'post') throw denied;
    return { data: [{ whatsapp_business_api_data: { id: '222' } }] };
  } });
  try {
    const result = await h.service.withAccountToken(null, true, c => c.subscribeToWebhooks('123456'));
    assert.equal(result.success, true);
    assert.equal(result.already_subscribed, true);
    assert.deepEqual(h.calls.map(c => [c.method, c.url, c.headers.Authorization]), [
      ['post', '/123456/subscribed_apps', 'Bearer secondary-token'],
      ['get', '/123456/subscribed_apps', 'Bearer secondary-token'],
    ]);
    assert.equal(h.logs.length, 0);
  } finally { h.close(); }
});

test('subscription confirmation cannot accept another app, malformed results, or an unreadable subscription', async () => {
  for (const response of [{ data: [] }, { data: [{ whatsapp_business_api_data: { id: '111' } }] },
    { data: [{ id: '222' }] }, { data: {} }, null]) {
    const denied = { response: { status: 403, data: { error: { code: 200 } } } };
    const h = fixture({ respond: async r => {
      if (r.method === 'post') throw denied;
      if (response === null) throw { code: 'ECONNABORTED' };
      return response;
    } });
    try {
      await assert.rejects(h.service.withAccountToken(null, true, c => c.subscribeToWebhooks('123456')),
        e => e.details === denied.response.data);
      assert.equal(h.calls.length, 2);
      assert.ok(h.calls.every(c => c.headers.Authorization === 'Bearer secondary-token'));
    } finally { h.close(); }
  }
});

test('other subscription failures remain failures without confirmation reads', async () => {
  for (const failure of [rejection(190), { code: 'ECONNABORTED' },
    { response: { status: 500, data: { error: { code: 200 } } } }]) {
    const h = fixture({ respond: async () => { throw failure; } });
    try {
      await assert.rejects(h.service.withAccountToken(null, true, c => c.subscribeToWebhooks('123456')));
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
});

test('a subscription confirmed by reading also prevents later switching to another app', async () => {
  const h = fixture({ respond: async r => {
    if (r.method === 'post') throw { response: { status: 403, data: { error: { code: 200 } } } };
    if (r.url.endsWith('/subscribed_apps')) return { data: [{ whatsapp_business_api_data: { id: '111' } }] };
    throw rejection(200);
  } });
  try {
    await assert.rejects(h.service.withOnboardingTokenFallback(null, async c => {
      await c.subscribeToWebhooks('123456'); await c.getTemplates('123456');
    }));
    assert.equal(h.calls.length, 3);
    assert.ok(h.calls.every(c => c.headers.Authorization === 'Bearer primary-token'));
  } finally { h.close(); }
});

test('secondary webhook verification checks destination and extra coexistence fields', async () => {
  for (const options of [
    { callback: 'https://other.example/webhook' }, { fields: ['messages'] },
    { coexistence: true }, { env: { WABA_WEBHOOK_CALLBACK_URL: '' } },
  ]) {
    const h = fixture(options);
    try {
      await assert.rejects(h.service.withOnboardingTokenFallback('secondary-token', c => c.verifyOnboardingWebhooks(!!options.coexistence)),
        e => e.code === 'WABA_WEBHOOK_CONFIGURATION_REQUIRED');
      assert.ok(h.calls.every(c => !c.url.endsWith('/subscribed_apps')));
    } finally { h.close(); }
  }
  const h = fixture({ fields: ['messages', 'account_update', 'history', 'smb_app_state_sync', 'smb_message_echoes'] });
  try {
    await h.service.withOnboardingTokenFallback('secondary-token', c => c.verifyOnboardingWebhooks(true));
    assert.equal(h.calls[0].headers.Authorization, 'Bearer 222|secondary-secret');
  } finally { h.close(); }
});

test('ordinary sends use the remembered secondary credential without automatic send retries', async () => {
  const h = fixture({ resourceToken: 'secondary-token', respond: async () => { throw rejection(190); } });
  try {
    await assert.rejects(h.service.sendMessage('1001', { to: '919000000000', type: 'text', text: { body: 'test' } }, true));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].headers.Authorization, 'Bearer secondary-token');
    assert.equal(h.calls[0].params.appsecret_proof, crypto.createHmac('sha256', 'secondary-secret').update('secondary-token').digest('hex'));
  } finally { h.close(); }
});

test('new-token configuration never borrows the primary app secret and supports the existing Messenger app keys', () => {
  const h = fixture();
  try {
    assert.equal(h.utils.wabaConfig('secondary-token').appId, '222');
    assert.equal(h.utils.wabaConfig('222|secondary-secret').appSecret, 'secondary-secret');
    delete h.env.META_NEW_APP_SECRET;
    assert.throws(() => h.utils.secondaryMetaToken(), e => e.code === 'WABA_CONFIGURATION_REQUIRED');
    h.env.FACEBOOK_MESSENGER_APP_SECRET = 'messenger-secret';
    assert.equal(h.utils.metaTokenAppConfig('secondary-token').appSecret, 'messenger-secret');
  } finally { h.close(); }
});

test('all ordinary Meta operations retry a definite primary rejection once using the matching secondary app', async () => {
  const operations = [
    s => s.sendMessage('1001', { to: '919000000000', type: 'text' }, true),
    s => s.sendMessage('1001', { to: '919000000000', type: 'text' }, true, true),
    s => s.markAsRead('1001', 'wamid.test'),
    s => s.getTemplates('123456'), s => s.createTemplate('123456', { name: 'test' }),
    s => s.getTemplate('2001'), s => s.updateTemplate('2001', { category: 'UTILITY' }),
    s => s.deleteTemplate('123456', 'test', '2001'), s => s.getWabaMessagingLimit('123456'),
    s => s.getPhoneNumbers('123456'), s => s.getPhoneNumberDetails('1001'),
    s => s.getMediaUrl('3001'), s => s.getWabaDetails('123456'), s => s.verifiedPhoneNumbers('1001'),
  ];
  for (const operation of operations) {
    const h = fixture({ respond: async r => {
      if (r.headers.Authorization === 'Bearer primary-token') throw rejection(190);
      return { id: '123456', data: [], success: true, messages: [{ id: 'wamid.accepted' }],
        is_on_biz_app: false, platform_type: 'CLOUD_API', status: 'CONNECTED' };
    } });
    try {
      await operation(h.service);
      assert.deepEqual(h.calls.map(c => c.headers.Authorization), ['Bearer primary-token', 'Bearer secondary-token']);
      assert.equal(h.calls[1].params.appsecret_proof, crypto.createHmac('sha256', 'secondary-secret').update('secondary-token').digest('hex'));
    } finally { h.close(); }
  }
});

test('ordinary sends do not retry uncertain delivery, restrictions, transient errors or saved customer authorization', async () => {
  const failures = [
    { code: 'ECONNABORTED' }, { code: 'ECONNRESET' }, rejection(131031), rejection(131048), rejection(4), rejection(100),
    { response: { status: 503, data: { error: { code: 190 } } } },
    { response: { status: 400, data: { error: { code: 190, is_transient: true } } } },
  ];
  for (const failure of failures) {
    const h = fixture({ respond: async () => { throw failure; } });
    try {
      await assert.rejects(h.service.sendMessage('1001', { to: '919000000000' }, true));
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
  for (const resourceToken of ['customer-token', 'secondary-token', 'primary-token']) {
    const h = fixture({ resourceToken, respond: async () => { throw rejection(190); } });
    try {
      await assert.rejects(h.service.createTemplate('123456', { name: 'test' }));
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].headers.Authorization, `Bearer ${resourceToken}`);
    } finally { h.close(); }
  }
  const h = fixture({ respond: async () => { throw rejection(190); } });
  try {
    await assert.rejects(h.service.sendMessage('1001', { to: '919000000000' }, true));
    assert.equal(h.calls.length, 2, 'secondary failure must stop, not alternate forever');
  } finally { h.close(); }
});

test('real Axios interceptors preserve authorization rejection through HTTP wrapping and retry with fresh headers', async () => {
  for (const failBoth of [false, true]) {
    const h = fixture({ realAxios: true, respond: async r => {
      if (failBoth || r.headers.get('Authorization') === 'Bearer primary-token') throw rejection(190);
      return { messages: [{ id: 'wamid.accepted' }] };
    } });
    try {
      const send = h.service.sendMessage('1001', { to: '919000000000', type: 'text', text: { body: 'hello' } }, true);
      if (failBoth) await assert.rejects(send); else assert.equal((await send).messages[0].id, 'wamid.accepted');
      assert.deepEqual(h.calls.map(c => c.headers.get('Authorization')), ['Bearer primary-token', 'Bearer secondary-token']);
      assert.equal(h.calls[0].data, h.calls[1].data);
      assert.equal(h.calls[0].httpsAgent, h.calls[1].httpsAgent, 'fallback preserves connection pooling without sharing credentials');
      assert.equal(h.calls[1].params.appsecret_proof, crypto.createHmac('sha256', 'secondary-secret').update('secondary-token').digest('hex'));
    } finally { h.close(); }
  }
});

test('concurrent operations cannot reuse another request authorization failure to retry an uncertain send', async () => {
  const h = fixture({ respond: async r => {
    if (r.url === '/1001/messages') throw { code: 'ECONNRESET' };
    if (r.headers.Authorization === 'Bearer primary-token') throw rejection(190);
    return { id: '2001' };
  } });
  try {
    const results = await Promise.allSettled([
      h.service.sendMessage('1001', { to: '919000000000' }, true), h.service.getTemplate('2001'),
    ]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
    assert.equal(h.calls.filter(c => c.url === '/1001/messages').length, 1);
    assert.equal(h.calls.filter(c => c.url === '/2001').length, 2);
  } finally { h.close(); }
});

test('media upload retry rebuilds multipart data and file streams', async () => {
  const streams = [], forms = [];
  const h = fixture({ dependencies: {
    fs: { createReadStream() { const stream = {}; streams.push(stream); return stream; } },
    'form-data': class {
      constructor() { forms.push(this); }
      append() {} getHeaders() { return { 'content-type': 'multipart/form-data; boundary=test' }; }
    },
  } });
  try {
    await h.service.uploadMedia('1001', { path: '/fake', originalname: 'test.png', mimetype: 'image/png' }, 'image');
    assert.equal(streams.length, 2); assert.notEqual(streams[0], streams[1]);
    assert.notEqual(forms[0], forms[1]);
    assert.deepEqual(h.calls.map(c => c.headers.Authorization), ['Bearer primary-token', 'Bearer secondary-token']);
  } finally { h.close(); }
});

test('template upload keeps session creation and binary upload on the same app after fallback', async () => {
  const h = fixture({ dependencies: { fs: { statSync: () => ({ size: 3 }), readFileSync: () => Buffer.from('abc') } },
    respond: async r => {
      if (r.headers.Authorization === 'Bearer primary-token') throw rejection(190);
      assert.equal(r.params.access_token, 'secondary-token');
      return { id: 'upload:secondary-session' };
    }, directPost: async (url, data, config) => {
      assert.ok(url.endsWith('/upload:secondary-session'));
      assert.equal(config.headers.Authorization, 'OAuth secondary-token');
      assert.equal(data.toString(), 'abc');
      return { data: { h: '4::sample' } };
    } });
  try {
    assert.equal(await h.service.uploadTemplateMedia({ path: '/fake', mimetype: 'image/png' }), '4::sample');
    assert.equal(h.calls.length, 3);
  } finally { h.close(); }
});

test('template sample uploads honor the phone account saved credential instead of a global token', async () => {
  const h = fixture({ resourceToken: 'secondary-token',
    dependencies: { fs: { statSync: () => ({ size: 3 }), readFileSync: () => Buffer.from('abc') } },
    respond: async r => {
      assert.equal(r.headers.Authorization, 'Bearer secondary-token');
      assert.equal(r.params.access_token, 'secondary-token');
      return { id: 'upload:secondary-session' };
    }, directPost: async (_url, _data, config) => {
      assert.equal(config.headers.Authorization, 'OAuth secondary-token'); return { data: { h: '4::sample' } };
    } });
  try {
    assert.equal(await h.service.uploadTemplateMedia({ path: '/fake', mimetype: 'image/png' }, '1001'), '4::sample');
    assert.equal(h.calls.length, 2);
  } finally { h.close(); }
});

test('media lookup and download use one selected token and save the result only once', async () => {
  let saves = 0;
  const h = fixture({
    respond: async r => {
      if (r.headers.Authorization === 'Bearer primary-token') throw rejection(190);
      return { url: 'https://media.example/file', mime_type: 'image/png' };
    },
    directGet: async (_url, config) => {
      assert.equal(config.headers.Authorization, 'Bearer secondary-token');
      return { data: Buffer.from('abc') };
    },
    firebase: { bucket: { name: 'test-bucket', file: () => ({ name: 'test-file', save: async () => { saves++; }, makePublic: async () => {} }) } },
  });
  try {
    assert.equal((await h.service.handleMedia('3001')).mime_type, 'image/png');
    assert.equal(saves, 1); assert.equal(h.calls.length, 3);
  } finally { h.close(); }
});

test('standalone secondary subscription still checks the webhook and coexistence configuration', async () => {
  for (const callback of ['https://api.example/v1/webhooks/meta', 'https://wrong.example/webhook']) {
    const h = fixture({ callback, fields: ['messages', 'account_update', 'history', 'smb_app_state_sync', 'smb_message_echoes'],
      respond: async r => {
        if (r.headers.Authorization === 'Bearer primary-token') throw rejection(190);
        return r.method === 'get' ? { data: [{ id: '1001', is_on_biz_app: true }] } : { success: true };
      } });
    try {
      if (callback.includes('wrong')) await assert.rejects(h.service.subscribeToWebhooks('123456'), e => e.code === 'WABA_WEBHOOK_CONFIGURATION_REQUIRED');
      else assert.equal((await h.service.subscribeToWebhooks('123456')).success, true);
      assert.equal(h.calls.filter(c => c.url.endsWith('/subscribed_apps')).length, callback.includes('wrong') ? 1 : 2);
    } finally { h.close(); }
  }
});

test('saved credential references survive process reloads and fail closed if the optional token is removed', async () => {
  const h = fixture();
  let credential, account = { connection_status: 'legacy', meta_data: { meta_token_source: 'secondary' } };
  const db = table => {
    const chain = { where() { return chain; }, whereNull() { return chain; }, leftJoin() { return chain; },
      andWhere() { return chain; }, select() { return chain; },
      async first() { return table === 'waba_credentials' ? credential : table === 'waba_accounts' ? account :
        { ...credential, connection_status: account.connection_status, waba_meta_data: account.meta_data }; } };
    return chain;
  };
  try {
    const credentials = loadSource('src/app/services/wabaCredentials.service.ts', {
      '@surefy/database': db, '../utils/wabaOnboarding': h.utils,
    }).default;
    assert.equal(await credentials.forAccount('owner', 'company', 'record'), 'secondary-token');
    assert.equal(await credentials.forResource('1001'), 'secondary-token');
    account = { connection_status: 'legacy', meta_data: {} };
    assert.equal(await credentials.forResource('1001'), 'primary-token');
    account = { connection_status: 'legacy', meta_data: { meta_token_source: 'secondary' } };
    delete h.env.META_NEW_APP_ACCESS_TOKEN;
    await assert.rejects(credentials.forResource('1001'), e => e.code === 'WABA_CREDENTIAL_UNAVAILABLE');
    account = { connection_status: 'connected', meta_data: {} };
    await assert.rejects(credentials.forResource('1001'), e => e.code === 'WABA_CREDENTIAL_UNAVAILABLE');
    credential = { user_id: 'owner', company_id: 'company', onboarding_id: 'job',
      token_encrypted: h.utils.sealToken('customer-token', { userId: 'owner', companyId: 'company' }, 'job') };
    assert.equal(await credentials.forResource('1001'), 'customer-token');
  } finally { h.close(); }
});

test('account update signatures from either configured app work, and invalid signatures do not reconcile', async () => {
  const h = fixture();
  try {
    let reconciled = 0;
    const facebook = loadSource('src/app/utils/facebook.ts', { crypto }, { process: { env: h.env } });
    const { wabaAccountUpdate } = loadSource('src/app/http/middleware/wabaAccountUpdate.ts', {
      '../../utils/facebook': facebook, '../../utils/wabaOnboarding': h.utils,
      '../../services/wabaOnboarding.service': { receiveAccountUpdates: async () => { reconciled++; } },
    }, { process: { env: h.env } });
    const body = { entry: [{ changes: [{ field: 'account_update' }] }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    for (const secret of ['primary-secret', 'secondary-secret', 'wrong-secret']) {
      const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      let error;
      await wabaAccountUpdate({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, {}, e => { error = e; });
      if (secret === 'wrong-secret') assert.equal(error.code, 'WABA_WEBHOOK_SIGNATURE_INVALID');
      else assert.equal(error, undefined);
    }
    assert.equal(reconciled, 2);
    delete h.env.META_NEW_APP_SECRET;
    const signature = 'sha256=' + crypto.createHmac('sha256', 'primary-secret').update(rawBody).digest('hex');
    let error;
    await wabaAccountUpdate({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, {}, e => { error = e; });
    assert.equal(error, undefined, 'incomplete optional configuration must not break primary webhooks');
  } finally { h.close(); }
});

test('verification confirms connected coexistence using only the saved secondary token and never registers it', async () => {
  const h = fixture({ resourceToken: 'secondary-token', respond: async r => {
    assert.equal(r.method, 'get'); assert.equal(r.url, '/1001');
    assert.ok(r.params.fields.includes('is_on_biz_app'));
    return { id: '1001', is_on_biz_app: true, platform_type: 'CLOUD_API', status: 'CONNECTED' };
  } });
  try {
    const result = await h.service.verifiedPhoneNumbers('1001');
    assert.equal(result.success, true); assert.equal(result.already_registered, true);
    assert.equal(result.connection_mode, 'coexistence');
    assert.deepEqual(h.calls.map(c => c.headers.Authorization), ['Bearer secondary-token']);
  } finally { h.close(); }
});

test('verification rejects incomplete SMB onboarding, unknown mode, on-premises and unverified Cloud numbers without registration', async () => {
  for (const [phone, code] of [
    [{ is_on_biz_app: true, platform_type: 'ON_PREMISE', status: 'DISCONNECTED', code_verification_status: 'NOT_VERIFIED' }, 'WABA_COEXISTENCE_PENDING'],
    [{ is_on_biz_app: true, platform_type: 'CLOUD_API', status: 'DISCONNECTED' }, 'WABA_COEXISTENCE_PENDING'],
    [{ is_on_biz_app: true, platform_type: 'ON_PREMISE', status: 'CONNECTED' }, 'WABA_COEXISTENCE_PENDING'],
    [{ platform_type: 'CLOUD_API', status: 'CONNECTED' }, 'WABA_PHONE_MODE_UNCONFIRMED'],
    [{ is_on_biz_app: false, platform_type: 'ON_PREMISE' }, 'WABA_PHONE_MODE_UNCONFIRMED'],
    [{ is_on_biz_app: false, platform_type: 'UNRECOGNIZED' }, 'WABA_PHONE_MODE_UNCONFIRMED'],
    [{ is_on_biz_app: false, platform_type: 'CLOUD_API', status: 'DISCONNECTED', code_verification_status: 'NOT_VERIFIED' }, 'WABA_PHONE_VERIFICATION_REQUIRED'],
  ]) {
    const h = fixture({ resourceToken: 'secondary-token', respond: async () => phone });
    try {
      await assert.rejects(h.service.verifiedPhoneNumbers('1001'), e => e.code === code && e.statusCode === 409);
      assert.deepEqual(h.calls.map(c => c.method), ['get']);
    } finally { h.close(); }
  }
});

test('already connected standard numbers retain primary credentials and skip duplicate registration', async () => {
  const h = fixture({ resourceToken: 'primary-token', respond: async () => ({ is_on_biz_app: false, platform_type: 'CLOUD_API', status: 'CONNECTED' }) });
  try {
    assert.equal((await h.service.verifiedPhoneNumbers('1001')).already_registered, true);
    assert.deepEqual(h.calls.map(c => c.method), ['get']);
    assert.equal(h.calls[0].headers.Authorization, 'Bearer primary-token');
  } finally { h.close(); }
});

test('standard verified numbers register once and require a confirmed connection afterward', async () => {
  for (const confirmed of [true, false]) {
    let reads = 0;
    const h = fixture({ resourceToken: 'secondary-token', respond: async r => {
      if (r.method === 'post') { assert.equal(r.url, '/1001/register'); return { success: true }; }
      reads++;
      return { is_on_biz_app: false, platform_type: 'CLOUD_API', status: reads > 1 && confirmed ? 'CONNECTED' : 'DISCONNECTED', code_verification_status: 'VERIFIED' };
    } });
    try {
      if (confirmed) assert.equal((await h.service.verifiedPhoneNumbers('1001')).success, true);
      else await assert.rejects(h.service.verifiedPhoneNumbers('1001'), e => e.code === 'WABA_REGISTRATION_PENDING');
      assert.deepEqual(h.calls.map(c => c.method), ['get', 'post', 'get']);
      assert.ok(h.calls.every(c => c.headers.Authorization === 'Bearer secondary-token'));
    } finally { h.close(); }
  }
});

test('an authorization failure after accepted registration never replays the write with the other app', async () => {
  let reads = 0;
  const h = fixture({ respond: async r => {
    if (r.method === 'post') return { success: true };
    if (++reads > 1) throw rejection(190);
    return { is_on_biz_app: false, platform_type: 'CLOUD_API', status: 'DISCONNECTED', code_verification_status: 'VERIFIED' };
  } });
  try {
    await assert.rejects(h.service.verifiedPhoneNumbers('1001'), e => e.code === 'WABA_REGISTRATION_PENDING');
    assert.deepEqual(h.calls.map(c => c.method), ['get', 'post', 'get']);
    assert.ok(h.calls.every(c => c.headers.Authorization === 'Bearer primary-token'));
  } finally { h.close(); }
});
