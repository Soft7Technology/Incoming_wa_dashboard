const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./helpers/background-database.cjs');
class HttpError extends Error { constructor({ message }) { super(message); } }
const errors = { '@surefy/exceptions/HTTP400Error': HttpError, '@surefy/exceptions/HTTP404Error': HttpError };
const validation = loadSource('src/app/utils/templateValidation.ts', errors);
const localId = '0315c3e7-1948-43d3-8d79-2a61dfc317c6';
const account = { companyId: 'company', userId: 'owner' };
function payload(handle = '4::single-opaque-upload-handle') {
  return { company_id: account.companyId, user_id: account.userId, waba_id: '1985960115426343',
    name: 'anirudh_utility', category: 'UTILITY', language: 'en_US',
    headerMode: 'fixed', headerMediaUrl: 'https://example.invalid/sample.pdf', headerDocumentFilename: 'sample.pdf',
    components: [
      { type: 'HEADER', format: 'DOCUMENT', filename: 'sample.pdf', example: { header_handle: [handle] } },
      { type: 'BODY', text: 'Dear {{1}},\n\n{{2}}\n\nPlease refer to the shared Wardrobe Planner.', example: { body_text: [['Guest', 'Wedding details']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Hello' }] },
    ] };
}
function fixture() {
  const calls = [], saves = [];
  const current = { id: 'meta-template', status: 'APPROVED', category: 'UTILITY', components: payload().components };
  const service = loadSource('src/app/services/template.service.ts', {
    ...errors, '../utils/templateValidation': validation,
    '@surefy/console/models/waba.model': {
      findByWabaId: async id => ({ id: localId, waba_id: id, company_id: account.companyId, user_id: account.userId }),
      findById: async () => ({ id: localId, waba_id: '1985960115426343', company_id: account.companyId, user_id: account.userId }),
    },
    '@surefy/console/models/template.model': {
      findByNameAndLanguage: async () => null,
      create: async value => { saves.push(value); return value; },
      findById: async () => ({ id: localId, template_id: current.id, waba_id: localId, company_id: account.companyId }),
      update: async (_id, value) => { saves.push(value); return value; },
    },
    './meta.service': {
      createTemplate: async (...args) => { calls.push(args); return { id: 'meta-template', status: 'PENDING' }; },
      getTemplate: async () => current,
      updateTemplate: async (...args) => { calls.push(args); current.status = 'PENDING'; current.components = args[1].components; },
    },
  }).default;
  return { service, calls, saves };
}

test('create removes the unsupported header filename and leaves other Meta fields and input intact', async () => {
  const f = fixture(), input = payload(), before = JSON.stringify(input);
  await f.service.createTemplate(input);
  const [wabaId, outbound] = f.calls[0];
  assert.equal(wabaId, input.waba_id);
  assert.equal(outbound.name, input.name);
  assert.equal(outbound.components[0].format, 'DOCUMENT');
  assert.deepEqual(Array.from(outbound.components[0].example.header_handle), ['4::single-opaque-upload-handle']);
  assert.equal(Object.hasOwn(outbound.components[0], 'filename'), false);
  for (const field of ['waba_id', 'company_id', 'user_id', 'headerMode', 'headerMediaUrl', 'headerDocumentFilename'])
    assert.equal(Object.hasOwn(outbound, field), false);
  assert.deepEqual(JSON.parse(JSON.stringify(outbound.components[1])), input.components[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(outbound.components[2])), input.components[2]);
  assert.equal(Object.hasOwn(f.saves[0].components[0], 'filename'), false);
  assert.equal(JSON.stringify(input), before);
});

test('malformed and concatenated handles fail locally without Meta calls or database writes', async () => {
  for (const handles of [[], [''], [' '], ['4::first\n4::second\n4::third'], ['4::first\r\n4::second'],
    ['4::one', '4::two'], ['4::contains space'], [null]]) {
    const f = fixture(), input = payload(); input.components[0].example.header_handle = handles;
    await assert.rejects(f.service.createTemplate(input), /exactly one complete Meta.*without spaces or newlines/);
    assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0);
  }
});

test('update strips the same unsupported field without mutating the input', async () => {
  const f = fixture(), input = { components: payload().components }, before = JSON.stringify(input);
  await f.service.updateTemplate(localId, input, account);
  assert.equal(Object.hasOwn(f.calls[0][1].components[0], 'filename'), false);
  assert.equal(f.calls[0][1].components[0].example.header_handle[0], '4::single-opaque-upload-handle');
  assert.equal(JSON.stringify(input), before);
});

test('valid text, image and video templates continue to validate', () => {
  for (const format of ['IMAGE', 'VIDEO', 'DOCUMENT']) {
    const input = payload(); input.components[0].format = format;
    validation.validateTemplatePayload(input, true);
  }
  const text = payload(); text.components[0] = { type: 'HEADER', format: 'TEXT', text: 'Wedding details' };
  validation.validateTemplatePayload(text, true);
  assert.equal(validation.metaTemplateComponents(text.components)[0].text, 'Wedding details');
});
