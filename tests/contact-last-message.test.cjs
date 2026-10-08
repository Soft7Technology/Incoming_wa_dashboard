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
  assert.match(sql, /CASE WHEN m.direction = 'inbound'\s+THEN regexp_replace\(m.from_phone/);
  assert.match(sql, /ELSE regexp_replace\(m.to_phone/);
  assert.match(sql, /ORDER BY m.created_at DESC NULLS LAST, m.id DESC\s+LIMIT 1/);
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.ok(!sql.includes('RIGHT(') && !sql.includes('LIKE'));
  const countsSql = sql.slice(sql.indexOf('COUNT(*) FILTER'));
  assert.match(countsSql, /WHERE m.inbox_read_at IS NOT NULL OR m.status = 'read' OR m.read_at IS NOT NULL/);
  assert.match(countsSql, /WHERE m.inbox_read_at IS NULL AND m.status IS DISTINCT FROM 'read' AND m.read_at IS NULL/);
  assert.match(countsSql, /m.direction = 'inbound'/);
  assert.match(countsSql, /m.status IS DISTINCT FROM 'deleted'/);
  for (const column of ['user_id', 'company_id', 'phone_number_id']) {
    assert.ok(countsSql.includes(`m.${column} = c.${column}`));
  }
  assert.match(countsSql, /CASE WHEN m.direction = 'inbound'\s+THEN regexp_replace\(m.from_phone/);
  assert.match(countsSql, /END = c.recipient/);
  assert.ok(!countsSql.includes('LIMIT'));
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
  const message = { id: 'latest', direction: 'outbound', type: 'interactive', status: 'delivered',
    inbox_read_at: '2026-10-08T03:45:00Z', read_at: null,
    content: { interactive: { type: 'button_reply', button_reply: { title: 'Talk to Support' } } },
    created_at: '2026-09-26T10:00:00Z' };
  let lookups = 0;
  const query = { where() { return this; }, clone() { return this; },
    toSQL() { return { toNative: () => ({}) }; }, count() { return this; }, first: async () => ({ count: '21' }),
    orderBy() { return this; }, limit() { return this; }, offset: async () => contacts };
  const service = load('src/app/services/contact.service.ts', {
    '../models/phoneNumber.model': { findByPhoneNumberId: async () => ({ id: 'business', user_id: 'owner', company_id: 'company' }) },
    '../models/contact.model': { findWithFilters: () => query },
    '../models/contactTagRelation.model': { getContactsWithTags: async () => [{ contact_id: 'sg', tags: ['vip'] }] },
    '../models/message.model': { findLatestForContacts: async page => {
      assert.equal(page, contacts); lookups++; return [{ contact_id: 'sg', last_message: message,
        read_count: '12', unread_count: '3' }];
    } },
  });
  const result = await service.getContacts('owner', { page: 2, limit: 20 }, 'business', 'company');
  assert.equal(lookups, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.contacts[0].last_message)), { ...message, timestamp: null });
  assert.equal(result.contacts[0].read_count, 12);
  assert.equal(result.contacts[0].unread_count, 3);
  assert.equal(result.contacts[0].read_status, 'read');
  assert.equal(result.contacts[1].read_count, 0);
  assert.equal(result.contacts[1].unread_count, 0);
  assert.equal(result.contacts[1].last_message, null);
  assert.equal(result.contacts[1].read_status, null);
  assert.deepEqual(result.contacts[0].tags, ['vip']);
  assert.equal(result.pagination.total, 21);
  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.total_pages, 2);
});

test('single-contact lookup returns numeric counts and defaults missing history to zero', async () => {
  for (const summary of [{ read_count: '5', unread_count: '2' }, undefined]) {
    const contact = { ...base, id: 'sg', phone_number: '81234567', country_code: '65' };
    const service = load('src/app/services/contact.service.ts', {
      '../models/contact.model': { findById: async () => contact },
      '../models/contactTagRelation.model': { findByContact: async () => [] },
      '../models/message.model': { findLatestForContacts: async contacts => {
        assert.equal(contacts.length, 1);
        assert.equal(contacts[0], contact);
        return summary ? [{ contact_id: contact.id, ...summary }] : [];
      } },
    });
    const result = await service.getContactById(contact.id);
    assert.equal(result.read_count, summary ? 5 : 0);
    assert.equal(result.unread_count, summary ? 2 : 0);
  }
});
