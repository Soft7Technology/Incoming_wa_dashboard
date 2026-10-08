require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const phone = require('../src/app/utils/importPhone');
class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => deps[name] || {}, console: { log() {}, warn() {} } });
  return exports.default;
}
function fixture() {
  const calls = [];
  const contactId = 'e2f364e3-d0d4-4dd6-b0b4-3bb57712763c';
  const scope = { user_id: 'owner', company_id: 'company', phone_number_id: 'sender' };
  const state = {
    contact: { ...scope, id: contactId, phone_number: '+919372597458', country_code: '91', assigned_to: ['member'] },
    sender: { id: 'sender', user_id: 'owner', company_id: 'company', phone_number_id: 'meta-sender' },
    message: { ...scope, id: 'message', wamid: 'wamid.incoming', direction: 'inbound', from_phone: '919372597458' },
    failReceipt: false,
  };
  const service = load('src/app/services/message.service.ts', {
    '../utils/importPhone': phone,
    uuid: require('uuid'),
    '../models/contact.model': { findById: async () => state.contact, findOwnedByPhone: async () => state.contact },
    '@surefy/console/models/phoneNumber.model': { findByPhoneNumberId: async () => state.sender },
    '@surefy/console/models/message.model': {
      findForInboxRead: async (account, target) => { calls.push({ account, target }); return state.message; },
      markInboxReadThrough: async message => { calls.push({ saved: message.id }); return [{ id: message.id }]; },
    },
    '@surefy/console/services/meta.service': { markAsRead: async (...args) => {
      calls.push({ receipt: args });
      if (state.failReceipt) throw new Error('Provider unavailable');
    } },
    '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError,
  });
  const input = { ...scope, actor_id: 'owner', contact_id: contactId };
  return { state, calls, service, input };
}

test('opening a contact resolves the scoped latest message and saves locally before sending a receipt', async () => {
  const { service, calls, input } = fixture();
  const result = await service.markAsRead(input);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { account: { user_id: 'owner', company_id: 'company', phone_number_id: 'sender' },
      target: { recipient: '919372597458' } },
    { saved: 'message' }, { receipt: ['meta-sender', 'wamid.incoming'] },
  ]);
  assert.equal(result.inbox_read, true);
  assert.equal(result.updated_count, 1);
  assert.equal(result.read_receipt_sent, true);
});

test('a failed WhatsApp read receipt still returns a saved inbox read state', async () => {
  const { service, state, input, calls } = fixture();
  state.failReceipt = true;
  const result = await service.markAsRead(input);
  assert.equal(result.inbox_read, true);
  assert.equal(result.read_receipt_sent, false);
  assert.ok(calls.some(call => call.saved === 'message'));
});

test('rejects wrong account, sender, contact, invalid identifiers and missing messages before updating', async () => {
  const cases = [
    [({ input }) => { input.company_id = 'other'; }, /Phone number not found/],
    [({ input }) => { input.user_id = 'other'; }, /Phone number not found/],
    [({ state }) => { state.sender.deleted_at = new Date(); }, /Phone number not found/],
    [({ state }) => { state.contact.company_id = 'other'; }, /Contact not found/],
    [({ state }) => { state.contact.user_id = 'other'; }, /Contact not found/],
    [({ state }) => { state.contact.phone_number_id = 'other'; }, /Contact not found/],
    [({ state }) => { state.contact.deleted_at = new Date(); }, /Contact not found/],
    [({ state }) => { state.contact = null; }, /Contact not found/],
    [({ state }) => { state.contact.phone_number = 'invalid'; }, /valid international phone/],
    [({ state }) => { state.message = null; }, /Message not found/],
    [({ input }) => { input.contact_id = 'invalid'; }, /Provide either/],
    [({ input }) => { input.message_id = 'wamid'; }, /Provide either/],
    [({ input }) => { delete input.contact_id; }, /Provide either/],
    [({ input }) => { delete input.contact_id; input.message_id = ' '; }, /Provide either/],
  ];
  for (const [modify, error] of cases) {
    const context = fixture();
    modify(context);
    await assert.rejects(context.service.markAsRead(context.input), error);
    assert.ok(!context.calls.some(call => call.saved || call.receipt));
  }
});

test('team members can only mark assigned conversations by contact or message ID', async () => {
  for (const identifier of ['contact_id', 'message_id']) {
    for (const assigned of [true, false]) {
      const { service, state, input, calls } = fixture();
      input.actor_id = 'member';
      if (identifier === 'message_id') { delete input.contact_id; input.message_id = 'wamid.incoming'; }
      state.contact.assigned_to = assigned ? ['member'] : [];
      if (assigned) assert.equal((await service.markAsRead(input)).inbox_read, true);
      else {
        await assert.rejects(service.markAsRead(input), /not assigned to you/);
        assert.ok(!calls.some(call => call.saved || call.receipt));
      }
    }
  }
});

test('mark-read controller uses authenticated account scope and accepts contact IDs', async () => {
  const calls = [];
  const controller = load('src/app/http/controllers/message.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
    '@surefy/console/services/message.service': { markAsRead: async data => { calls.push(data); return { inbox_read: true }; } },
    '@surefy/exceptions/HTTP400Error': HttpError,
  });
  const req = { ownerId: 'owner', userId: 'member', companyId: 'company', body: {
    company_id: 'untrusted', user_id: 'untrusted', phone_number_id: 'sender', contact_id: 'contact',
  } };
  await controller.markAsRead(req, {});
  assert.equal(calls[0].user_id, 'owner');
  assert.equal(calls[0].actor_id, 'member');
  assert.equal(calls[0].company_id, 'company');
  assert.equal(calls[0].contact_id, 'contact');
  await assert.rejects(controller.markAsRead({ ...req, body: { phone_number_id: 'sender' } }, {}),
    /Phone number ID and either message ID or contact ID/);
});
