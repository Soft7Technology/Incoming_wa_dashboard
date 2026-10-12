const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('import job update serializes JSONB arrays before calling BaseModel', async () => {
  let received;
  class BaseModel {
    constructor() {}
    async update(id, data) { received = { id, data }; return data; }
  }
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync('src/app/models/importJob.model.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, require: () => ({ BaseModel }) });

  await exports.default.update('job-1', {
    list_id: 'list-1',
    total_rows: 2,
    file_headers: ['Name', 'Phone'],
    errors: [{ row: 2, error: 'invalid' }],
  });

  assert.equal(received.id, 'job-1');
  assert.equal(received.data.file_headers, '["Name","Phone"]');
  assert.equal(received.data.errors, '[{"row":2,"error":"invalid"}]');
  assert.equal(received.data.list_id, 'list-1');
  assert.equal(received.data.total_rows, 2);
});

function listHarness() {
  const state = { job: { id: 'job', user_id: 'owner', company_id: 'company', phone_number_id: 'phone', list_id: null },
    lists: [], locks: 0, failLink: false };
  let activeTransaction;
  const transaction = table => {
    let conditions = {};
    const query = {
      where(values) { Object.assign(conditions, values); return this; },
      whereNull() { return this; },
      forUpdate() { state.locks++; return this; },
      first: async () => (table === 'import_jobs' ? [state.job] : state.lists)
        .find(row => Object.entries(conditions).every(([key, value]) => row[key] === value)),
      update: async data => {
        if (state.failLink) throw Error('Association write failed');
        Object.assign(state.job, data);
      },
    };
    return query;
  };
  class BaseModel {
    constructor() {
      this.db = { transaction: async fn => {
        const before = { job: { ...state.job }, lists: [...state.lists] };
        activeTransaction = transaction;
        try { return await fn(transaction); }
        catch (error) { state.job = before.job; state.lists = before.lists; throw error; }
        finally { activeTransaction = null; }
      } };
    }
  }
  const deps = {
    '@surefy/models/base.model': { BaseModel },
    './contactList.model': { create: async (data, trx) => {
      assert.equal(trx, activeTransaction);
      const list = { ...data, id: 'list' }; state.lists.push(list); return list;
    } },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/models/importJob.model.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, require: id => deps[id] });
  const input = { user_id: 'owner', company_id: 'company', phone_number_id: 'phone', name: 'List', file_headers: ['Phone'] };
  return { state, model: exports.default, input };
}

test('worker list creation holds the job lock and retries reuse its associated list', async () => {
  const h = listHarness();
  const first = await h.model.getOrCreateContactList('job', h.input);
  assert.equal(h.state.job.list_id, first.id);
  assert.equal(await h.model.getOrCreateContactList('job', h.input), first);
  assert.equal(h.state.lists.length, 1);
  assert.equal(h.state.locks, 2);
});

test('list creation rolls back if job association fails, then a retry creates one list', async () => {
  const h = listHarness(); h.state.failLink = true;
  await assert.rejects(h.model.getOrCreateContactList('job', h.input), /Association write failed/);
  assert.equal(h.state.job.list_id, null);
  assert.equal(h.state.lists.length, 0);
  h.state.failLink = false;
  const list = await h.model.getOrCreateContactList('job', h.input);
  assert.equal(h.state.job.list_id, list.id);
  assert.equal(h.state.lists.length, 1);
});

test('list association rejects another account and never creates a list for it', async () => {
  const h = listHarness();
  await assert.rejects(h.model.getOrCreateContactList('job', { ...h.input, company_id: 'other' }), /requested account/);
  assert.equal(h.state.lists.length, 0);
});
