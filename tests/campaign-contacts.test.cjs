require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const knex = require('knex');
class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, console: { log() {} }, require: name => { assert.ok(name in deps, name); return deps[name]; } });
  return exports;
}
const countryCode = require('../src/app/utils/countryCode');
const { parseCampaignContactQuery: parse } = load('src/app/utils/campaignContactFilters.ts', {
  uuid: require('uuid'), '@surefy/exceptions/HTTP400Error': HttpError, './countryCode': countryCode,
});
const id = '87af00e3-cdf0-4c59-9950-143dbadf5ebc';
const base = { phone_number_id: '661886587013056' };

test('query parser validates filters, comma-separated IDs and boolean values', () => {
  const query = parse({ ...base, search: ' Parth ', country_code: '+91,65', tag_ids: id, list_ids: [id],
    status: id, is_valid: 'false', is_opted_out: 'false', attributes: '{"city":"Pune"}', sortBy: 'name', sortOrder: 'asc' });
  assert.equal(query.filters.search, 'Parth');
  assert.equal(query.filters.is_valid, false);
  assert.equal(query.filters.country_code.join(','), '91,65');
  assert.equal(query.filters.attributes.city, 'Pune');
  for (const extra of [{ page: '1' }, { limit: '10' }, { search: {} }, { sortBy: 'password' },
    { is_opted_out: 'true' }, { is_valid: 'yes' }, { attributes: '{bad' }, { attributes: '[]' },
    { tag_ids: 'bad' }, { list_ids: [] }, { country_code: {} }]) {
    assert.throws(() => parse({ ...base, ...extra }));
  }
  assert.throws(() => parse({}), /phone_number_id/);
  assert.equal(parse({ ...base, search: '  ' }).filters.search, undefined);
});

function serviceFixture({ rows = [], blocked = [], foreign = false } = {}) {
  let selection, reads = 0;
  const service = load('src/app/services/campaignContacts.service.ts', {
    '../utils/campaignContactFilters': { parseCampaignContactQuery: parse },
    '../models/phoneNumber.model': { findByPhoneNumberId: async () => ({ id, user_id: foreign ? 'other' : 'owner', company_id: 'company' }) },
    '../models/contact.model': { findCampaignSelection: async (...args) => { selection = args; reads++; return rows; } },
    './contactOptOut.service': { excluded: async () => new Set(blocked) },
    '../utils/campaignPhone': require('../src/app/utils/campaignPhone'),
    '../utils/campaignRecipients': require('../src/app/utils/campaignRecipients'),
    '@surefy/exceptions/HTTP400Error': HttpError, '@surefy/exceptions/HTTP404Error': HttpError,
  }).default;
  return { service, selection: () => selection, reads: () => reads };
}
test('eligible list returns all matches, deduplicates recipients and excludes opted-out duplicates', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), phone_number: '+919372597' + String(i).padStart(3, '0'), is_opted_out: false }));
  rows.push({ ...rows[0], id: 'duplicate' });
  const f = serviceFixture({ rows, blocked: ['919372597001'] });
  const result = await f.service.eligible('owner', 'company', 'owner', base);
  assert.equal(result.total, 29);
  assert.equal(result.contacts.some(c => c.id === '1'), false);
  assert.equal('pagination' in result, false);
  assert.equal(f.selection()[2], id);
});
test('team selections require assignment and foreign senders fail before contact reads', async () => {
  const f = serviceFixture();
  const empty = await f.service.eligible('owner', 'company', 'member', base);
  assert.equal(empty.total, 0);
  assert.equal(empty.contacts.length, 0);
  assert.equal(f.selection()[3].filters.onlyAssignedToUserId, 'member');
  const foreign = serviceFixture({ foreign: true });
  await assert.rejects(foreign.service.eligible('owner', 'company', 'owner', base), /not connected/);
  assert.equal(foreign.reads(), 0);
});

test('SQL scopes search, country, tags, lists and attributes without a limit or offset', () => {
  const db = knex({ client: 'pg' });
  class BaseModel { constructor(table) { this.db = db; this.table = table; } query() { return this.db(this.table); } }
  const model = load('src/app/models/contact.model.ts', {
    '@surefy/models/base.model': { BaseModel }, '../utils/importPhone': require('../src/app/utils/importPhone'),
    '../utils/countryCode': countryCode, '../../database': db, './phoneNumber.model': {}, knex,
    '@surefy/exceptions/HTTP400Error': HttpError,
  }).default;
  const query = parse({ ...base, search: 'Parth', country_code: '91', tag_ids: id, list_ids: id,
    status: id, attributes: '{"city":"Pune"}' });
  query.filters.onlyAssignedToUserId = id;
  const compiled = model.findCampaignSelection('owner', 'company', id, query).toSQL();
  const sql = compiled.sql;
  for (const fragment of ['"contacts"."user_id" = ?', '"contacts"."company_id" = ?', '"phone_number_id" = ?',
    '"contacts"."is_opted_out" = ?', '"deleted_at" is null', 'assigned_to @>', '"name" ilike',
    '"phone_number" ilike', '"email" ilike', 'contact_tag_relations', 'contact_list_relations', 'attributes->>? = ?']) {
    assert.ok(sql.includes(fragment), fragment);
  }
  assert.ok(!/\blimit\b|\boffset\b/.test(sql));
  assert.ok(!sql.includes('Parth') && compiled.bindings.includes('%Parth%'));
  assert.ok(compiled.bindings.includes(false));
});
