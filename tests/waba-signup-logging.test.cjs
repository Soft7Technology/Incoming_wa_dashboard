const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadSource } = require('./helpers/background-database.cjs');
class CustomError extends Error {
  constructor(message, statusCode, isOperational, details) { super(message); Object.assign(this, {statusCode, isOperational, details}); }
}
const env = { META_APP_ID: '999', META_APP_SECRET: 'test-app-secret', META_API_VERSION: 'v25.0',
  WABA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
const utils = loadSource('src/app/utils/wabaOnboarding.ts', {crypto, '@surefy/exceptions/CustomError': {CustomError}},
  {process: {env}, Buffer, Date});
const code='SECRET-AUTHORIZATION-CODE-DO-NOT-LOG', token='SECRET-META-ACCESS-TOKEN-DO-NOT-LOG';
function transport(respond) {
  const calls = [], logs = [];
  const { WabaGraph } = loadSource('src/app/services/wabaGraph.service.ts', {
    axios: { request: async config => { calls.push(config); return { data: await respond(config, calls.length) }; } },
    crypto, '../utils/wabaOnboarding': utils,
  }, { process: { env }, Date, console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  return { graph: new WabaGraph(token), exchange: (value = code) => new WabaGraph().exchange(value), calls, logs };
}
test('code exchange uses server credentials exactly once and strips sensitive Meta errors', async () => {
  const success = transport(async () => ({ access_token: token, expires_in: 3600 }));
  assert.equal((await success.exchange()).token, token); assert.equal(success.calls.length, 1);
  assert.equal(success.calls[0].params.code, code); assert.equal(success.calls[0].params.client_secret, env.META_APP_SECRET);
  assert.equal(success.calls[0].timeout, 8000); assert.equal(success.calls[0].maxRedirects, 0); assert.equal(success.logs.length, 0);
  for (const error of [Object.assign(Error(`leaked ${token}`), { response: { status: 400, data: { error: { message: code } } } }), Error(token)]) {
    const failure = transport(async () => { throw error; });
    await assert.rejects(failure.exchange(), safe => !safe.message.includes(token) && !safe.message.includes(code) && safe.retryable === false);
    assert.equal(failure.calls.length, 1); assert.equal(failure.logs.length, 1);
    const output = JSON.stringify(failure.logs);
    for (const secret of [code, token, env.META_APP_SECRET]) assert.ok(!output.includes(secret));
  }
});

test('exchange failures log useful Meta diagnostics without the Axios request or credentials', async () => {
  const encodedSecret = encodeURIComponent(env.META_APP_SECRET);
  const f = transport(async config => { throw {
    response: { status: 400, data: { error: { code: 100, error_subcode: 36008, type: 'OAuthException',
      message: `Verification code has expired. code=${code}; client_secret=${encodedSecret}; access_token=EAAunknownToken12345678901234567890`,
      fbtrace_id: 'TRACE-test-123', extra: token } } },
    config, request: { raw: token }, stack: token,
  }; });
  await assert.rejects(f.exchange(), error => error.code === 'META_CODE_INVALID' && !error.retryable);
  assert.equal(f.calls.length, 1); assert.equal(f.logs.length, 1);
  const [prefix, details] = f.logs[0];
  assert.equal(prefix, '[WABA signup] Meta code exchange failed');
  assert.equal(details.http_status, 400); assert.equal(details.meta_error_code, 100);
  assert.equal(details.meta_error_subcode, 36008); assert.equal(details.meta_error_type, 'OAuthException');
  assert.equal(details.fbtrace_id, 'TRACE-test-123'); assert.equal(details.automatic_code_retry, false);
  assert.match(details.meta_message, /Verification code has expired/);
  for (const secret of [code, token, env.META_APP_SECRET, encodedSecret, 'EAAunknownToken12345678901234567890']) {
    assert.ok(!JSON.stringify(f.logs).includes(secret));
  }
  assert.ok(!('config' in details)); assert.ok(!('request' in details));
});

test('exchange logs preserve classification and never replay permission, configuration or uncertain failures', async () => {
  for (const [status, metaCode, networkCode, expected] of [
    [400, 101, undefined, 'WABA_CONFIGURATION_REQUIRED'],
    [403, 200, undefined, 'META_PERMISSION_REQUIRED'],
    [500, 2, undefined, 'CODE_EXCHANGE_UNCONFIRMED'],
    [429, 4, undefined, 'CODE_EXCHANGE_UNCONFIRMED'],
    [undefined, undefined, 'ECONNABORTED', 'CODE_EXCHANGE_UNCONFIRMED'],
    [undefined, undefined, 'ENOTFOUND', 'CODE_EXCHANGE_UNCONFIRMED'],
  ]) {
    const f = transport(async () => { throw { code: networkCode, message: token,
      ...(status ? { response: { status, data: { error: { code: metaCode, message: 'Meta request rejected' } } } } : {}) }; });
    await assert.rejects(f.exchange(), error => error.code === expected && error.retryable === false);
    assert.equal(f.calls.length, 1); assert.equal(f.logs.length, 1);
    assert.equal(f.logs[0][1].network_code, networkCode ?? null);
    assert.ok(!JSON.stringify(f.logs).includes(token));
  }
});

test('missing-token exchange responses log a safe diagnostic and remain unconfirmed', async () => {
  const f = transport(async () => ({ unexpected: token }));
  await assert.rejects(f.exchange(), error => error.code === 'CODE_EXCHANGE_UNCONFIRMED');
  assert.equal(f.calls.length, 1); assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0][1].http_status, 200);
  assert.match(f.logs[0][1].meta_message, /no usable access token/);
  assert.ok(!JSON.stringify(f.logs).includes(token));
});

test('exchange logs redact encoded codes, credential fields, line breaks and oversized messages', async () => {
  const input = 'private/code?value=example&next=secret';
  const f = transport(async () => { throw { response: { status: 400, data: { error: {
    code: 100, message: `Bad request ${encodeURIComponent(input)}\nBearer unknown-token; code=another-secret; ` + 'x'.repeat(2000),
    type: 'OAuthException', fbtrace_id: input,
  } } } }; });
  await assert.rejects(f.exchange(input), error => error.code === 'META_CODE_INVALID');
  const details = f.logs[0][1];
  const output = JSON.stringify(f.logs);
  for (const secret of [input, encodeURIComponent(input), 'unknown-token', 'another-secret']) assert.ok(!output.includes(secret));
  assert.ok(details.meta_message.length <= 1000); assert.ok(!details.meta_message.includes('\n'));
  const malformed = transport(async () => { throw Error('transport failed'); });
  await assert.rejects(malformed.exchange('private\ud800'), error => error.code === 'CODE_EXCHANGE_UNCONFIRMED');
  assert.equal(malformed.logs.length, 1);
});
