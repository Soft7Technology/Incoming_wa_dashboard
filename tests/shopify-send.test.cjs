const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  vm = require('node:vm'),
  ts = require('typescript'),
  crypto = require('node:crypto');
class HttpError extends Error {
  constructor({ message }) {
    super(message);
  }
}
function moduleWithMocks(file, deps, logs = []) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
    {
      exports,
      process,
      Date,
      Buffer,
      console: {
        log: (...v) => logs.push(v),
        info: (...v) => logs.push(v),
        warn: (...v) => logs.push(v),
        error: (...v) => logs.push(v),
      },
      require: (id) => deps[id] || {},
    },
  );
  return exports.default;
}
function sender() {
  const calls = [],
    records = [];
  const svc = moduleWithMocks('src/app/services/message.service.ts', {
    uuid: { validate: (value) => /^[0-9a-f-]{36}$/.test(value) },
    '../utils/importPhone': {
      parseImportedPhone: () => ({ phone_number: '4155552671', country_code: '1' }),
      buildRecipient: () => '14155552671',
    },
    '../models/contact.model': { findCampaignPhoneCandidates: async () => [] },
    './contactOptOut.service': { isBlocked: async () => false },
    '@surefy/console/models/message.model': {
      createOutbound: async (row) => {
        records.push(row);
        return row;
      },
      update: async () => {},
    },
    '@surefy/console/models/company.model': { canSend: async () => true },
    '@surefy/console/services/meta.service': {
      sendMessage: async (...args) => {
        calls.push(args);
        return { messages: [{ id: 'wamid' }] };
      },
    },
    '@surefy/exceptions/HTTP400Error': HttpError,
  });
  return { svc, calls, records };
}
test('HTTP callers cannot attach arbitrary WhatsApp messages to a Shopify job', async () => {
  const h = sender(),
    id = crypto.randomUUID();
  await assert.rejects(h.svc.sendMessage({ shopify_job_id: id, messageUUID: id }), /reserved for the Shopify/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.records.length, 0);
});
test('the Shopify sender links message history to retention and requests redacted Meta logs', async () => {
  const h = sender(),
    id = crypto.randomUUID();
  await h.svc.sendMessage(
    {
      shopify_job_id: id,
      messageUUID: id,
      user_id: 'owner',
      company_id: 'company',
      phone_number_id: 'sender',
      campaign_id: null,
      to: '4155552671',
      country_code: '1',
      type: 'template',
      template: { name: 'paid', language: 'en_US', components: [] },
    },
    {
      source: 'shopify',
      phoneNumber: { id: 'sender', phone_number_id: 'meta-sender', user_id: 'owner', company_id: 'company' },
      templateRecord: { id: 'template', components: [{ type: 'BODY', text: 'Order paid' }] },
    },
  );
  assert.equal(h.records[0].shopify_job_id, id);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][3], true);
});
test('Meta errors for Shopify messages cannot log or return the customer phone/content', async () => {
  const logs = [];
  const meta = moduleWithMocks(
    'src/app/services/meta.service.ts',
    {
      axios: {
        create: () => ({
          post: async () => {
            throw { response: { data: { error: { message: 'Secret +14155552671 order 77' } } } };
          },
        }),
      },
      '../utils/importPhone': { parseWhatsAppPhone: () => ({ country_code: '1', phone_number: '4155552671' }) },
      '@surefy/exceptions/HTTP500Error': HttpError,
    },
    logs,
  );
  await assert.rejects(
    meta.sendMessage('sender', { to: '14155552671', secret: 'order 77' }, false, true),
    /could not be confirmed/,
  );
  assert.ok(!JSON.stringify(logs).includes('4155552671'));
  assert.ok(!JSON.stringify(logs).includes('order 77'));
});
