require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const phone = require('../src/app/utils/importPhone');
function load(file, deps) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => deps[id] || {}, console: { log() {} } });
  return exports.default;
}
function modelHarness() {
  const calls = [];
  class BaseModel {
    constructor() { this.db = { raw: async (sql, bindings) => { calls.push({ sql, bindings }); return { rows: [] }; } }; }
  }
  const model = load('src/app/models/message.model.ts', {
    '@surefy/models/base.model': { BaseModel }, '../utils/importPhone': phone,
  });
  return { model, calls };
}
const base = { user_id: 'owner', company_id: 'company', phone_number_id: 'business' };
test('latest-message lookup batches full country identities and restricts account and sender scope', async () => {
  const { model, calls } = modelHarness();
  await model.findLatestForContacts([
    { ...base, id: 'india', phone_number: '7579380000', country_code: '91' },
    { ...base, id: 'usa', phone_number: '7579380000', country_code: '1' },
    { ...base, id: 'singapore', phone_number: '81234567', country_code: '65' },
  ]);
  assert.equal(calls.length, 1);
  const { sql, bindings } = calls[0];
  const identities = JSON.parse(bindings[0]);
  assert.deepEqual(identities.map(row => row.recipient), ['917579380000', '17579380000', '6581234567']);
  for (const column of ['user_id', 'company_id', 'phone_number_id']) assert.ok(sql.includes(`m.${column} = c.${column}`));
  assert.match(sql, /m.direction = 'inbound'.*m.from_phone/);
  assert.match(sql, /m.direction = 'outbound'.*m.to_phone/);
  assert.match(sql, /ORDER BY m.created_at DESC NULLS LAST, m.id DESC\s+LIMIT 1/);
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.ok(!sql.includes('RIGHT(') && !sql.includes('LIKE'));
});
test('empty pages and contacts without reliable country or business scope perform no message query', async () => {
  const { model, calls } = modelHarness();
  await model.findLatestForContacts([]);
  await model.findLatestForContacts([
    { ...base, id: 'unknown', phone_number: '81234567' },
    { ...base, id: 'unscoped', phone_number: '81234567', country_code: '65', phone_number_id: null },
  ]);
  assert.equal(calls.length, 0);
});
test('contact list attaches full message or null while retaining tags and pagination', async () => {
  const contacts = [{ ...base, id: 'sg', phone_number: '81234567', country_code: '65' },
    { ...base, id: 'in', phone_number: '9372597458', country_code: '91' }];
  const message = { id: 'latest', direction: 'inbound', type: 'interactive', status: 'read',
    content: { interactive: { type: 'button_reply', button_reply: { title: 'Talk to Support' } } },
    created_at: '2026-09-26T10:00:00Z' };
  let lookups = 0;
  const query = { where() { return this; }, clone() { return this; },
    toSQL() { return { toNative: () => ({}) }; }, count() { return this; }, first: async () => ({ count: '21' }),
    orderBy() { return this; }, limit() { return this; }, offset: async () => contacts };
  const service = load('src/app/services/contact.service.ts', {
    '../models/contact.model': { findWithFilters: () => query },
    '../models/contactTagRelation.model': { getContactsWithTags: async () => [{ contact_id: 'sg', tags: ['vip'] }] },
    '../models/message.model': { findLatestForContacts: async page => {
      assert.equal(page, contacts); lookups++; return [{ contact_id: 'sg', last_message: message }];
    } },
  });
  const result = await service.getContacts('owner', { page: 2, limit: 20 }, 'business', 'company');
  assert.equal(lookups, 1);
  assert.equal(result.contacts[0].last_message, message);
  assert.equal(result.contacts[1].last_message, null);
  assert.deepEqual(result.contacts[0].tags, ['vip']);
  assert.equal(result.pagination.total, 21);
  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.total_pages, 2);
});
