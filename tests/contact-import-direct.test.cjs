const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, deps) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => {
    if (id.includes('contactImport.queue') || id === 'bullmq') throw Error('Unexpected queue dependency');
    return deps[id] || {};
  }, console: { log() {}, error() {} } });
  return exports;
}
test('API import awaits processing, returns final counts, and reads status without Redis', async () => {
  let stored, completed = false;
  const service = load('src/app/services/contact.service.ts', {
    path: require('node:path'),
    '../utils/importColumn': { resolveImportColumn: (_, value) => value },
    './xlsxParser.service': {
      validateFile: async () => ({ valid: true }),
      getFilePreview: async () => ({ headers: ['Phone'], total_rows: 2 }),
    },
    '../models/importJob.model': {
      create: async row => { stored = { ...row, id: 'job' }; return stored; },
      findById: async () => ({ ...stored, status: 'completed', result: { imported: 1, failed: 1 } }),
    },
    './contactImport.service': { processContactImport: async data => {
      assert.equal(data.jobId, 'job');
      assert.equal(data.userId, 'owner');
      assert.equal(data.companyId, 'company');
      assert.equal(data.options.phoneColumn, 'Phone');
      await Promise.resolve();
      completed = true;
      return { total: 2, imported: 1, failed: 1, list_id: 'list' };
    } },
  }).default;
  const result = await service.importContactsDirect('owner', 'company', 'phone', '91', '/upload.xlsx', 'List', { phoneColumn: 'Phone' });
  assert.equal(completed, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.progress_percentage, 100);
  assert.equal(result.result.imported, 1);
  assert.equal(result.result.failed, 1);
  assert.equal((await service.getImportJobStatus('job')).bull_job_state, null);
});
function importer(fatal = false) {
  const calls = [], result = {};
  const deps = {
    path: require('node:path'),
    './planUsage.service': { run: async (owner, feature, create) => {
      calls.push([owner, feature]); return create('transaction');
    } },
    '@surefy/console/models/importJob.model': {
      updateStatus: async () => { if (fatal) throw Error('database unavailable'); },
      update: async () => {},
      updateProgress: async (_, data) => { result.progress = data; },
      markAsCompleted: async (_, data) => { result.completed = data; },
      markAsFailed: async (_, error) => { result.failure = error.message; },
    },
    '@surefy/console/services/xlsxParser.service': {
      validateFile: async () => ({ valid: true }),
      parseContactsFromFile: async () => ({
        headers: ['Phone'], valid: 2, invalid: 0, needs_country: 0, errors: [],
        contacts: [{ phone_number: '111', country_code: '91' }, { phone_number: '222', country_code: '91' }],
      }),
    },
    '@surefy/console/models/contact.model': {
      findOwnedByPhone: async () => null,
      create: async (row, trx) => {
        assert.equal(trx, 'transaction');
        if (row.phone_number === '222') throw Error('row rejected');
        return { ...row, id: 'contact' };
      },
    },
    '@surefy/console/models/contactList.model': { create: async () => ({ id: 'list' }), update: async () => {} },
    '@surefy/console/models/contactListRelation.model': { addContactToList: async () => { result.linked = true; } },
    '@surefy/console/models/contactTagRelation.model': { bulkAddTags: async () => { result.tagged = true; } },
    '@surefy/console/models/contactTag.model': { incrementContactCount: async () => {} },
  };
  const processImport = load('src/app/services/contactImport.service.ts', deps).processContactImport;
  return { run: () => processImport({ jobId: 'job', userId: 'owner', companyId: 'company', phone_number_id: 'phone',
    country_code: '91', filePath: '/upload.xlsx', listName: 'List', options: { tagIds: ['tag'] } }), result, calls };
}
test('shared importer retains plan checks, list/tag writes, progress, and partial row failures without a worker', async () => {
  const h = importer();
  const result = await h.run();
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].error, 'row rejected');
  assert.equal(h.result.linked, true);
  assert.equal(h.result.tagged, true);
  assert.equal(h.result.progress.processed_rows, 2);
  assert.equal(h.result.completed, result);
  assert.deepEqual(h.calls, [['owner', 'Contact'], ['owner', 'Contact']]);
});
test('fatal import failures persist failed status and reject the API operation', async () => {
  const h = importer(true);
  await assert.rejects(h.run(), /database unavailable/);
  assert.equal(h.result.failure, 'database unavailable');
  assert.equal(h.result.completed, undefined);
});