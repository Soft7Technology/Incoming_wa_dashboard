const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { loadSource } = require('./helpers/background-database.cjs');
const summary = loadSource('src/app/utils/contactImportSummary.ts');
const list = { id: 'list', user_id: 'owner', company_id: 'company', phone_number_id: 'phone', name: 'Audience',
  total_contacts: 2212, valid_contacts: 2201, invalid_contacts: 4, file_headers: ['Name', 'Phone Number'] };
function job(statistics) { return { id: 'job', list_id: 'list', user_id: 'owner', company_id: 'company', phone_number_id: 'phone',
  total_rows: 2212, import_options: { phone_column: 'Phone Number', statistics } }; }

test('list summary returns durable preview fields and missing-country samples', () => {
  const stats = { total_rows: 2212, valid_count: 2201, invalid_count: 4, needs_country_count: 7, importable_count: 2208,
    duplicate_count: 21, unique_count: 2187, detected_phone_column: 'Phone Number', selected_phone_column: 'Phone Number',
    duplicate_preview: [{ phone_number: '+447879543645', occurrences: 3, duplicate_rows: 2 }],
    needs_country_preview: [{ phone_number: '+9372597458', name: 'Missing country', country_code: null }] };
  const result = summary.contactListImportSummary(list, job(stats));
  for (const field of Object.keys(stats)) assert.deepEqual(result[field], stats[field]);
  assert.equal(result.import_job_id, 'job'); assert.equal(result.statistics_source, 'import_job');
});

test('old lists preserve recorded counts and use null for unknown duplicate/country data', () => {
  const old = summary.contactListImportSummary(list);
  assert.equal(old.total_rows, 2212); assert.equal(old.valid_count, 2201); assert.equal(old.invalid_count, 4);
  assert.equal(old.importable_count, 2208); assert.equal(old.detected_phone_column, 'Phone Number');
  assert.equal(old.duplicate_count, null); assert.equal(old.duplicate_preview, null);
  assert.equal(old.needs_country_count, null); assert.equal(old.needs_country_preview, null);
  assert.equal(old.statistics_source, 'legacy_list');
  const recorded = job(); recorded.result = { duplicate_count: 21, unique_count: 2187, needs_country_count: 7 };
  const known = summary.contactListImportSummary(list, recorded);
  assert.equal(known.duplicate_count, 21); assert.equal(known.needs_country_count, 7);
  assert.equal(known.duplicate_preview, null);
  const zero = summary.contactListImportSummary(list, job({ duplicate_count: 0, needs_country_count: 0 }));
  assert.deepEqual(Array.from(zero.duplicate_preview), []); assert.deepEqual(Array.from(zero.needs_country_preview), []);
});

test('foreign-user, company, list and phone snapshots cannot supply list metadata', () => {
  for (const field of ['user_id', 'company_id', 'phone_number_id', 'list_id']) {
    const foreign = { ...job({ duplicate_count: 999 }), [field]: 'other' };
    const result = summary.contactListImportSummary(list, foreign);
    assert.equal(result.duplicate_count, null); assert.equal(result.import_job_id, null);
  }
});

test('large preview arrays are bounded to five samples in saved-list responses', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({ phone_number: '+' + index }));
  const result = summary.contactListImportSummary(list, job({ duplicate_preview: records, needs_country_preview: records }));
  assert.equal(result.duplicate_preview.length, 5); assert.equal(result.needs_country_preview.length, 5);
});

test('list/job lookups compile with account scope, deleted filters and latest-job ordering', async () => {
  const knex = require('knex')({ client: 'pg' });
  const statements = [];
  knex.client.runner = builder => ({ run: async () => { statements.push(builder.toSQL()); return []; } });
  class BaseModel { constructor(table) { this.table = table; this.db = knex; } query() { return knex(this.table); } }
  const deps = { '@surefy/models/base.model': { BaseModel }, './contactList.model': {} };
  const lists = loadSource('src/app/models/contactList.model.ts', deps).default;
  const jobs = loadSource('src/app/models/importJob.model.ts', deps).default;
  await lists.findByUserId('owner', 'company');
  await jobs.latestForLists('owner', 'company', ['list']);
  for (const query of statements) {
    assert.ok(query.bindings.includes('owner')); assert.ok(query.bindings.includes('company'));
    assert.match(query.sql, /"deleted_at" is null/);
  }
  assert.match(statements[1].sql, /distinct on \("list_id"\)/);
  assert.match(statements[1].sql, /order by "list_id" asc, "created_at" desc, "id" desc/);
  const before = statements.length;
  await jobs.latestForLists('owner', 'company', []);
  assert.equal(statements.length, before);
});

test('list service enriches all entries in one batch and never parses files', async () => {
  const lists = [list, { ...list, id: 'second', name: 'Second' }], reads = [];
  const exports = {};
  const deps = { '../utils/contactImportSummary': summary,
    '../models/contactList.model': { findByUserId: async (userId, companyId) => { reads.push(['lists', userId, companyId]); return lists; } },
    '../models/importJob.model': { latestForLists: async (...args) => { reads.push(['jobs', ...args]); return [job({ duplicate_count: 21, needs_country_count: 7 })]; } },
    './xlsxParser.service': { getValidatedPreview() { throw Error('List requests must not parse files'); } },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/contact.service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, require: id => deps[id] || {} });
  const result = await exports.default.getLists('owner', 'company');
  assert.equal(reads.length, 2); assert.deepEqual(Array.from(reads[1][3]), ['list', 'second']);
  assert.equal(result[0].duplicate_count, 21); assert.equal(result[0].name, 'Audience');
  assert.equal(result[1].duplicate_count, null); assert.equal(result[1].name, 'Second');
  lists.length = 0;
  const empty = await exports.default.getLists('owner', 'company');
  assert.equal(empty.length, 0); assert.equal(reads.length, 3, 'empty lists must skip the job query');
});
