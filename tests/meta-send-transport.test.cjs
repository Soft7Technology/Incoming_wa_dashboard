const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const https = require('node:https');

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => {
    if (id in dependencies) return dependencies[id];
    throw new Error(`Unexpected dependency ${id}`);
  }, Date, ...globals });
  return exports;
}
const errors = load('src/app/utils/metaSendError.ts');
const { getMessageError } = load('src/app/utils/messageError.ts');
class HttpError extends Error {
  constructor({ message, details }) { super(message); this.details = details; }
}
class WabaError extends Error {
  constructor(code, message, retryable, statusCode) { super(message); Object.assign(this, { code, retryable, statusCode }); }
}

function fixture(failure) {
  const logs = [], calls = [];
  let options;
  const response = { messages: [{ id: 'wamid.accepted' }] };
  const service = load('src/app/services/meta.service.ts', {
    '../utils/campaignPhone': { campaignRecipientNumber: value => value },
    '../utils/importPhone': { parseWhatsAppPhone: () => ({ country_code: '91', phone_number: '9000000000' }) },
    axios: { create(config) {
      options = config;
      return { interceptors: { request: { use() {} } }, async get(...args) {
        calls.push(args);
        if (failure) throw failure;
        return { data: { id: '123456', whatsapp_business_manager_messaging_limit: 'TIER_2K' } };
      }, async post(...args) {
        calls.push(args);
        if (failure) throw failure;
        return { data: response };
      } };
    } },
    '@surefy/exceptions/HTTP500Error': HttpError,
    '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/config/firebase.config': {},
    '../models/activityLogs.model': {},
    './wabaCredentials.service': {},
    crypto: require('node:crypto'),
    https,
    '../utils/metaSendError': errors,
    '../utils/wabaOnboarding': { WabaOnboardingError: WabaError },
  }, { process: { env: { META_ACCESS_TOKEN: 'secret-access-token' } }, console: {
    error: (...args) => logs.push(args), log: (...args) => logs.push(args),
  } }).default;
  const payload = { to: '919000000000', type: 'text', text: { body: 'private message body' } };
  return { service, options, logs, calls, response, payload };
}

function aggregateFailure() {
  return Object.assign(new AggregateError([
    Object.assign(new Error('connect timeout with private address'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('private IPv6 address unreachable'), { code: 'ENETUNREACH' }),
  ], 'Error'), {
    code: 'ETIMEDOUT',
    config: { headers: { Authorization: 'Bearer secret-access-token' }, data: 'private message body' },
  });
}

test('messaging limit fetch requests only the WABA ID and tier through the existing transport', async () => {
  const h = fixture();
  try {
    const result = await h.service.getWabaMessagingLimit('123456');
    assert.equal(result.whatsapp_business_manager_messaging_limit, 'TIER_2K');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], '/123456');
    assert.equal(h.calls[0][1].params.fields, 'id,whatsapp_business_manager_messaging_limit');
    assert.equal(h.logs.length, 0);
  } finally { h.options.httpsAgent.destroy(); }
});

test('messaging limit failures never expose credentials or provider bodies', async () => {
  for (const [failure, status] of [[aggregateFailure(), 502], [{ response: { data: {
    error: { code: 190, message: 'secret-access-token' } } } }, 403]]) {
    const h = fixture(failure);
    try {
      await assert.rejects(h.service.getWabaMessagingLimit('123456'), error => {
        assert.equal(error.statusCode, status);
        assert.ok(!error.message.includes('secret-access-token'));
        assert.ok(!JSON.stringify(error).includes('secret-access-token'));
        return true;
      });
      assert.equal(h.logs.length, 0);
    } finally { h.options.httpsAgent.destroy(); }
  }
});

test('Meta sends use a scoped IPv4 agent, retain a deadline and send once', async () => {
  const originalGlobalAgent = https.globalAgent;
  const h = fixture();
  try {
    assert.equal(h.options.httpsAgent.options.family, 4);
    assert.equal(h.options.httpsAgent.options.keepAlive, true);
    assert.equal(h.options.timeout, 30000);
    assert.equal(https.globalAgent, originalGlobalAgent);
    assert.equal(await h.service.sendMessage('123456', h.payload), h.response);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], '/123456/messages');
  } finally { h.options.httpsAgent.destroy(); }
});

test('reproduced AggregateError survives HTTP wrapping and message-table extraction', async () => {
  const h = fixture(aggregateFailure());
  try {
    await assert.rejects(h.service.sendMessage('123456', h.payload), error => {
      const saved = getMessageError(error);
      assert.equal(error.message, 'Failed to send message via Meta API');
      assert.equal(saved.error_code, 'ETIMEDOUT');
      assert.match(saved.error_message, /connection.*timed out/i);
      return true;
    });
    assert.equal(h.calls.length, 1);
    const diagnostic = h.logs[0][1];
    assert.equal(diagnostic.network_code, 'ETIMEDOUT');
    assert.deepEqual(Array.from(diagnostic.connection_error_codes), ['ETIMEDOUT', 'ENETUNREACH']);
    assert.equal(typeof diagnostic.elapsed_ms, 'number');
    const logged = JSON.stringify(h.logs);
    for (const secret of ['secret-access-token', 'private message body', '919000000000', 'private IPv6']) {
      assert.equal(logged.includes(secret), false);
    }
  } finally { h.options.httpsAgent.destroy(); }
});

test('Meta error codes and trace IDs survive without logging provider text or headers', async () => {
  const provider = { error: { code: 131042, error_subcode: 9, message: 'Business eligibility payment issue',
    error_data: { details: 'private provider details' }, fbtrace_id: 'trace_123' } };
  const h = fixture({ message: 'HTTP failure', code: 'ERR_BAD_REQUEST', response: { status: 400, data: provider } });
  try {
    await assert.rejects(h.service.sendMessage('123456', h.payload), error => {
      assert.equal(error.details, provider);
      assert.equal(getMessageError(error).error_code, '131042');
      assert.equal(getMessageError(error).error_message, 'private provider details');
      return true;
    });
    assert.equal(h.logs[0][1].upstream_status, 400);
    assert.equal(h.logs[0][1].meta_trace_id, 'trace_123');
    assert.equal(h.logs[0][1].meta_code, 131042);
    assert.equal(JSON.stringify(h.logs).includes('private provider details'), false);
  } finally { h.options.httpsAgent.destroy(); }
});

test('ambiguous timeout is not retried and does not claim the message was never sent', async () => {
  const h = fixture({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' });
  try {
    await assert.rejects(h.service.sendMessage('123456', h.payload), error => {
      assert.equal(getMessageError(error).error_code, 'ECONNABORTED');
      assert.match(getMessageError(error).error_message, /delivery is unconfirmed/);
      return true;
    });
    assert.equal(h.calls.length, 1);
  } finally { h.options.httpsAgent.destroy(); }
});

test('Shopify redaction retains generic response and omits sender from diagnostics', async () => {
  const h = fixture(aggregateFailure());
  try {
    await assert.rejects(h.service.sendMessage('123456', h.payload, false, true), error => {
      assert.equal(error.message, 'WhatsApp message outcome could not be confirmed.');
      assert.equal(error.details, undefined);
      return true;
    });
    assert.equal(h.logs[0][1].phone_number_id, undefined);
    assert.equal(h.logs[0][1].network_code, 'ETIMEDOUT');
  } finally { h.options.httpsAgent.destroy(); }
});

test('diagnostics ignore untrusted fields and handle missing error objects', () => {
  assert.equal(errors.metaSendError(null).details, 'Unknown error');
  const result = errors.metaSendError({ code: 'Bearer SECRET', errors: [{ code: 'EAI_AGAIN' }],
    response: { status: 'private', data: { error: { fbtrace_id: 'private text with spaces', code: 'private' } } } });
  assert.equal(result.diagnostic.network_code, 'EAI_AGAIN');
  assert.equal(result.diagnostic.upstream_status, undefined);
  assert.equal(result.diagnostic.meta_trace_id, undefined);
  assert.equal(result.diagnostic.meta_code, undefined);
});
