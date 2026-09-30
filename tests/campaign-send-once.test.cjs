const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function sender({ fail = false, persistenceFailure = false } = {}) {
  let calls = 0;
  const deps = {
    '../utils/campaignPhone': { campaignRecipientNumber: n => n.replace(/^\+/, '') },
    './contactOptOut.service': { isBlocked: async () => false },
    '@surefy/console/models/message.model': {
      create: async row => row,
      update: async () => { if (persistenceFailure) throw Error('write failed'); },
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
  vm.runInNewContext(js, { exports, require: n => deps[n] || {}, console: { info() {} }, process: { pid: 1, env: {} } });
  const send = (to = '+6581234567', campaign = 'campaign') => exports.default.sendMessage({
    company_id: 'company', user_id: 'user', campaign_id: campaign, phone_number_id: 'phone',
    messageUUID: 'message', to, type: 'text', text: { body: 'hello' },
  }, { phoneNumber: { id: 'phone', company_id: 'company', user_id: 'user', phone_number_id: 'meta-phone' },
    allowUnverifiedRecipient: true });
  return { send, calls: () => calls };
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
    await assert.rejects(h.send('+6581234568'));
    assert.equal(h.calls(), 2);
  });
}
