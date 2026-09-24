const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const knex = require('knex');
const c1 = '11111111-1111-4111-8111-111111111111';
const c2 = '22222222-2222-4222-8222-222222222222';
const tag = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
class HttpError extends Error { constructor({ message }) { super(message); } }
function setup({ contacts = [c1, c2], tags = [tag], existing = [] } = {}) {
  const db = knex({ client: 'pg' });
  const queries = [], relations = new Set(existing);
  const database = { transaction: callback => callback(db) };
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL(); queries.push(query);
    const table = builder._single.table;
    if (query.method === 'select') return (table === 'contacts' ? contacts : tags).map(id => ({ id }));
    if (query.method === 'insert') {
      const inserted = [];
      for (const row of builder._single.insert) {
        const key = `${row.contact_id}:${row.tag_id}`;
        if (!relations.has(key)) { relations.add(key); inserted.push({ tag_id: row.tag_id }); }
      }
      return inserted;
    }
    return 1;
  } });
  function load(file, dependencies) {
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(code, { exports, require: name => dependencies[name] || HttpError });
    return exports;
  }
  const model = load('src/app/models/contactBulkTags.model.ts', {}).default;
  const exports = load('src/app/services/contactBulkTags.service.ts', {
    '@surefy/database': database,
    '../models/contactBulkTags.model': model,
  });
  return { db, queries, add: exports.addTagsToContacts };
}

test('bulk tagging deduplicates IDs, retains existing tags, and counts only inserted relations', async () => {
  const env = setup({ existing: [`${c1}:${tag}`] });
  try {
    const result = await env.add('owner', 'company', 'owner', [c1, c2, c1], [tag, tag.toUpperCase()]);
    assert.equal(result.contact_count, 2);
    assert.equal(result.tag_count, 1);
    assert.equal(result.added_count, 1);
    assert.equal(result.already_assigned_count, 1);
    const updates = env.queries.filter(query => query.method === 'update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].bindings[0], 1);
    const retry = await env.add('owner', 'company', 'owner', [c1, c2], [tag]);
    assert.equal(retry.added_count, 0);
    assert.equal(retry.already_assigned_count, 2);
    assert.equal(env.queries.filter(query => query.method === 'update').length, 1);
  } finally { await env.db.destroy(); }
});

test('both contact and tag queries require owner, company, non-deleted state, and member assignments', async () => {
  const env = setup();
  try {
    await env.add('owner', 'company', 'member', [c1, c2], [tag]);
    const reads = env.queries.filter(query => query.method === 'select');
    for (const query of reads) {
      assert.ok(query.bindings.includes('owner') && query.bindings.includes('company'));
      assert.match(query.sql, /"deleted_at" is null/);
      assert.match(query.sql, /for update/);
    }
    assert.match(reads[0].sql, /assigned_to @>/);
    assert.ok(reads[0].bindings.includes('member'));
  } finally { await env.db.destroy(); }
});

test('an inaccessible contact or tag rejects the whole batch before inserting', async () => {
  for (const options of [{ contacts: [c1] }, { tags: [] }]) {
    const env = setup(options);
    try {
      await assert.rejects(env.add('owner', 'company', 'owner', [c1, c2], [tag]), /not found/);
      assert.ok(!env.queries.some(query => query.method === 'insert' || query.method === 'update'));
    } finally { await env.db.destroy(); }
  }
});

test('missing scope and invalid or oversized batches are rejected before querying', async () => {
  const env = setup();
  try {
    await assert.rejects(env.add(undefined, 'company', 'owner', [c1], [tag]), /context/);
    for (const contacts of [[], 'not-an-array', ['bad-id'], Array(501).fill(c1)]) {
      await assert.rejects(env.add('owner', 'company', 'owner', contacts, [tag]), /contact_ids/);
    }
    for (const tags of [[], [null], Array(51).fill(tag)]) {
      await assert.rejects(env.add('owner', 'company', 'owner', [c1], tags), /tag_ids/);
    }
    assert.equal(env.queries.length, 0);
  } finally { await env.db.destroy(); }
});
