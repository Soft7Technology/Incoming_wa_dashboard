const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function sender({ fail = false, persistenceFailure = false } = {}) {
  let calls = 0, writes = 0;
  const messages = new Set();
  const deps = {
    '../utils/campaignPhone': { campaignRecipientNumber: n => n.replace(/^\+/, '') },
    './contactOptOut.service': { isBlocked: async () => false },
    '@surefy/console/models/message.model': {
      createOutbound: async row => {
        const key = `${row.campaign_id}:${row.phone_number_id}:${row.to_phone}`;
        if (messages.has(key)) throw Object.assign(Error('existing message'), { code: 'CAMPAIGN_MESSAGE_EXISTS' });
        messages.add(key);
        return row;
      },
      update: async () => { writes++; if (persistenceFailure) throw Object.assign(Error('write failed'), persistenceFailure === 'database' ? { code: '42P01' } : {}); },
    },
    '@surefy/console/models/company.model': { canSend: async () => true },
    '@surefy/console/services/meta.service': {
      sendMessage: async () => {
        calls++;
        if (fail) throw Error('Meta timeout');
        return { messages: [{ id: 'wamid' }] };
      },
    },
    '@surefy/console/app/utils/messageError': { getMessageError: e => ({ error_message: e.message }) },
  };
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync('src/app/services/message.service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, require: n => n.endsWith('/activePhone') ? require('./helpers/active-phone.cjs') : n.endsWith('/databaseErrors') ? require('./helpers/background-database.cjs').databaseErrors : deps[n] || {}, console: { info() {} }, process: { pid: 1, env: {} } });
  const send = (to = '+6581234567', campaign = 'campaign') => exports.default.sendMessage({
    company_id: 'company', user_id: 'user', campaign_id: campaign, phone_number_id: 'phone',
    messageUUID: 'message', to, type: 'text', text: { body: 'hello' },
  }, { phoneNumber: { id: 'phone', company_id: 'company', user_id: 'user', phone_number_id: 'meta-phone' },
    allowUnverifiedRecipient: true });
  return { send, calls: () => calls, writes: () => writes };
}

test('one service invocation makes exactly one Meta call', async () => {
  const h = sender();
  await h.send();
  assert.equal(h.calls(), 1);
});

for (const options of [{ fail: true }, { persistenceFailure: true }]) {
  test(`service never retries after failure: ${JSON.stringify(options)}`, async () => {
    const h = sender(options);
    await assert.rejects(h.send());
    assert.equal(h.calls(), 1);
    await assert.rejects(h.send(), { code: 'CAMPAIGN_MESSAGE_EXISTS' });
    assert.equal(h.calls(), 1);
    await assert.rejects(h.send('+6581234568'));
    assert.equal(h.calls(), 2);
  });
}

test('two concurrent callers reach Meta once using outbound history', async () => {
 const h=sender();
 const results=await Promise.allSettled([h.send(),h.send('6581234567')]);
 assert.equal(h.calls(),1);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});

test('database failure saving an accepted send avoids a second failing status write', async () => {
  const h = sender({ persistenceFailure: 'database' });
  await assert.rejects(h.send(), { code: '42P01' });
  assert.equal(h.calls(), 1); assert.equal(h.writes(), 1);
});

function metaSender(providerError) {
  const { loadSource } = require('./helpers/background-database.cjs');
  const failureHandlers = [];
  class HttpError extends Error { constructor({ message, details }) { super(message); this.details = details; } }
  let calls = 0;
  const service = loadSource('src/app/services/meta.service.ts', {
    '../utils/campaignPhone': { campaignRecipientNumber: value => value },
    '../utils/importPhone': {},
    axios: { create: () => ({
      interceptors: { request: { use() {} }, response: { use(_success, failure) { failureHandlers.push(failure); } } },
      post() {
        calls++;
        let result = Promise.reject(providerError);
        for (const failure of failureHandlers) result = result.catch(failure);
        return result;
      },
    }) },
    '@surefy/exceptions/HTTP500Error': HttpError, '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/config/firebase.config': {}, '../models/activityLogs.model': {},
    './wabaCredentials.service': {}, crypto: require('node:crypto'),
  }, { process: { env: { META_ACCESS_TOKEN: 'server-token' } } }).default;
  const { getMessageError } = loadSource('src/app/utils/messageError.ts');
  return { service, calls: () => calls, getMessageError };
}

test('campaign send errors retain the real Meta message, code and detailed reason', async () => {
  for (const metaError of [
    { code: 132000, error_subcode: 2494073, message: 'Number of parameters does not match the expected number of params',
      error_data: { details: 'body: number of localizable_params (0) does not match the expected number of params (2)' } },
    { code: 190, message: 'Error validating access token: Session has expired.' },
  ]) {
    const h = metaSender({ response: { status: 400, data: { error: metaError } },
      config: { headers: { Authorization: 'Bearer server-token' } }, request: { private: true } });
    await assert.rejects(h.service.sendMessage('1001', { to: '6581234567', type: 'template' }, true), error => {
      const failure = h.getMessageError(error);
      assert.equal(failure.error_code, String(metaError.code));
      assert.equal(failure.error_message, metaError.error_data?.details || metaError.message);
      assert.deepEqual(error.details.error, metaError);
      assert.equal(error.config, undefined);
      assert.equal(error.request, undefined);
      return true;
    });
    assert.equal(h.calls(), 1);
  }
});

test('campaign network failures keep their original reason and are not retried', async () => {
  const h = metaSender(Error('timeout of 30000ms exceeded'));
  await assert.rejects(h.service.sendMessage('1001', { to: '6581234567' }, true), error => {
    assert.equal(h.getMessageError(error).error_message, 'timeout of 30000ms exceeded');
    return true;
  });
  assert.equal(h.calls(), 1);
});
