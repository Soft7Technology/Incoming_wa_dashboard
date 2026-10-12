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
    if (id === './contactImport.service') throw Error('API must not execute the importer');
    return deps[id] || {};
  }, process: { cwd: () => '/workspace' }, console: { log() {}, error() {} } });
  return exports;
}
test('API queues a tracked import with account scope and column mappings and returns before worker processing', async () => {
  let stored;
  const queued = [];
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
    '../../queues/contactImport.queue': { contactImportQueue: {
      add: async (...args) => queued.push(args),
      getJob: async id => { assert.equal(id, 'job'); return { getState: async () => 'completed' }; },
    } },
  }).default;
  const result = await service.queueContactImport('owner', 'company', 'phone', '91', '/upload.xlsx', 'List', { phoneColumn: 'Phone' });
  assert.equal(result, stored);
  assert.equal(result.status, 'queued');
  assert.equal(result.import_options.execution_mode, 'worker');
  assert.equal(result.result, undefined);
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], 'contact-import');
  assert.deepEqual(JSON.parse(JSON.stringify(queued[0][1])), {
    jobId: 'job', userId: 'owner', companyId: 'company', phone_number_id: 'phone', country_code: '91',
    filePath: '/upload.xlsx', listName: 'List', options: { phoneColumn: 'Phone' },
  });
  assert.equal(queued[0][2].jobId, 'job');
  assert.equal((await service.getImportJobStatus('job')).bull_job_state, 'completed');
});
test('enqueue failures persist a failed import job and propagate instead of returning accepted', async () => {
  let failure;
  const service = load('src/app/services/contact.service.ts', {
    path: require('node:path'),
    '../utils/importColumn': { resolveImportColumn: (_, value) => value },
    './xlsxParser.service': { validateFile: async () => ({ valid: true }), getFilePreview: async () => ({ headers: ['Phone'], total_rows: 2 }) },
    '../models/importJob.model': { create: async () => ({ id: 'job' }), markAsFailed: async (id, error) => { failure = { id, error }; } },
    '../../queues/contactImport.queue': { contactImportQueue: { add: async () => { throw Error('Redis unavailable'); } } },
  }).default;
  await assert.rejects(service.queueContactImport('owner', 'company', 'phone', '', '/upload.xlsx', 'List'), /Redis unavailable/);
  assert.equal(failure.id, 'job');
  assert.match(failure.error.message, /Redis unavailable/);
});

test('invalid files are rejected before creating or enqueueing jobs', async () => {
  const service = load('src/app/services/contact.service.ts', {
    './xlsxParser.service': { validateFile: async () => ({ valid: false, errors: ['No rows'] }) },
    '@surefy/exceptions/HTTP400Error': class extends Error { constructor({ message }) { super(message); } },
  }).default;
  await assert.rejects(service.queueContactImport('owner', 'company', 'phone', '', '/upload.xlsx', 'List'), /Invalid XLSX file: No rows/);
});

test('completed historical API imports retain status polling without connecting to Redis', async () => {
  const service = load('src/app/services/contact.service.ts', {
    '../models/importJob.model': { findById: async () => ({ id: 'old', status: 'completed', import_options: { execution_mode: 'api' } }) },
  }).default;
  assert.equal((await service.getImportJobStatus('old')).bull_job_state, null);
});

test('contact import endpoint returns 202 with a queued job and the authenticated owner', async () => {
  const calls = [];
  const controller = load('src/app/http/controllers/contact.controller.ts', {
    path: require('node:path'),
    fs: { existsSync: () => true, copyFileSync() {}, unlinkSync() {} },
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, message, data, status) => ({ message, data, status }) },
    '@surefy/utils/HttpStatusCode': { HttpStatusCode: { ACCEPTED: 202 } },
    '@surefy/console/services/contact.service': { queueContactImport: async (...args) => {
      calls.push(args); return { id: 'job', status: 'queued', total_rows: 2, progress_percentage: 0 };
    } },
  }).default;
  const response = await controller.importContacts({ ownerId: 'owner', userId: 'member', companyId: 'company',
    body: { phone_number_id: 'phone', list_name: 'List', phone_column: 'Phone', tag_ids: 'tag1,tag2' },
    file: { path: '/temporary/upload.xlsx', originalname: 'upload.xlsx' },
  }, {});
  assert.equal(response.status, 202);
  assert.equal(response.data.job_id, 'job');
  assert.equal(response.data.status, 'queued');
  assert.equal(response.data.imported, undefined);
  assert.equal(calls[0][0], 'owner');
  assert.equal(calls[0][1], 'company');
  assert.deepEqual(Array.from(calls[0][6].tagIds), ['tag1', 'tag2']);
});

test('contact worker consumes the queued payload and forwards progress to BullMQ', async () => {
  let processor, options, name;
  class Worker {
    constructor(queueName, fn, opts) { name = queueName; processor = fn; options = opts; }
    on() {}
  }
  const progress = [], data = { jobId: 'job' }, result = { imported: 2 };
  load('src/queues/processors/contactImport.processor.ts', {
    bullmq: { Worker },
    '../../app/services/contactImport.service': { processContactImport: async (received, report) => {
      assert.equal(received, data); await report(50); await report(100); return result;
    } },
  });
  assert.equal(name, 'contact-import');
  assert.equal(options.concurrency, 2);
  assert.equal(await processor({ id: 'job', data, updateProgress: async value => progress.push(value) }), result);
  assert.deepEqual(progress, [50, 100]);
});

function importer(fatal = false, allInvalid = false, failProgressOnce = false) {
  const calls = [], result = {};
  const contacts = new Map();
  const job = { id: 'job', user_id: 'owner', company_id: 'company', phone_number_id: 'phone', file_path: '/upload.xlsx', status: 'queued' };
  let savedList;
  const deps = {
    path: require('node:path'),
    './planUsage.service': { run: async (owner, feature, create) => {
      calls.push([owner, feature]); return create('transaction');
    } },
    '@surefy/console/models/importJob.model': {
      findById: async () => job,
      getOrCreateContactList: async (_id, data) => {
        if (!savedList) { savedList = { ...data, id: 'list' }; result.listCreations = (result.listCreations || 0) + 1; }
        return savedList;
      },
      updateStatus: async () => { if (fatal) throw Error('database unavailable'); },
      update: async () => {},
      updateProgress: async (_, data) => {
        if (failProgressOnce) { failProgressOnce = false; throw Error('Progress write failed'); }
        result.progress = data;
      },
      markAsCompleted: async (_, data) => { result.completed = data; job.status = 'completed'; job.result = data; },
      markAsFailed: async (_, error) => { result.failure = error.message; },
    },
    '@surefy/console/services/xlsxParser.service': {
      validateFile: async () => ({ valid: true }),
      parseContactsFromFile: async () => allInvalid ? ({
        headers: ['Phone'], valid: 0, invalid: 2, needs_country: 0,
        errors: [{ row: 2, error: 'Invalid phone' }, { row: 3, error: 'Invalid phone' }], contacts: [],
      }) : ({
        headers: ['Phone'], valid: 2, invalid: 0, needs_country: 0, errors: [],
        contacts: [{ phone_number: '111', country_code: '91' }, { phone_number: '222', country_code: '91' }],
      }),
    },
    '@surefy/console/models/contact.model': {
      findOwnedByPhone: async (_user, phone) => contacts.get(phone),
      update: async (id, data) => ({ id, ...data }),
      create: async (row, trx) => {
        assert.equal(trx, 'transaction');
        assert.equal(row.source, 'import');
        if (row.phone_number === '222') throw Error('row rejected');
        const contact = { ...row, id: 'contact' };
        contacts.set(row.phone_number, contact);
        return contact;
      },
    },
    '@surefy/console/models/contactList.model': { create: async () => ({ id: 'list' }), update: async () => {} },
    '@surefy/console/models/contactListRelation.model': { addContactToList: async () => { result.linked = true; } },
    '@surefy/console/models/contactTagRelation.model': { bulkAddTags: async () => { result.tagged = true; } },
    '@surefy/console/models/contactTag.model': { updateContactCount: async () => {
      result.tagCountUpdated = true;
      result.tagCountCalls = (result.tagCountCalls || 0) + 1;
    } },
  };
  const processImport = load('src/app/services/contactImport.service.ts', deps).processContactImport;
  return { run: (updateProgress) => processImport({ jobId: 'job', userId: 'owner', companyId: 'company', phone_number_id: 'phone',
    country_code: '91', filePath: '/upload.xlsx', listName: 'List', options: { tagIds: ['tag'] } }, updateProgress), result, calls, job };
}
test('worker importer retains plan checks, list/tag writes, progress, and partial row failures', async () => {
  const h = importer();
  const result = await h.run();
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].error, 'row rejected');
  assert.equal(h.result.linked, true);
  assert.equal(h.result.tagged, true);
  assert.equal(h.result.tagCountUpdated, true);
  assert.equal(h.result.progress.processed_rows, 2);
  assert.equal(h.result.completed, result);
  assert.deepEqual(h.calls, [['owner', 'Contact'], ['owner', 'Contact']]);
});
test('fatal import failures persist failed status and reject for worker retry', async () => {
  const h = importer(true);
  await assert.rejects(h.run(), /database unavailable/);
  assert.equal(h.result.failure, 'database unavailable');
  assert.equal(h.result.completed, undefined);
});

test('redelivery of a completed import returns the saved result without importing again', async () => {
  const h = importer();
  const first = await h.run();
  const count = h.calls.length;
  assert.equal(await h.run(), first);
  assert.equal(h.calls.length, count);
});

test('worker rejects mismatched job scope without changing that job', async () => {
  const h = importer();
  h.job.company_id = 'other';
  await assert.rejects(h.run(), /not found in the requested account/);
  assert.equal(h.result.failure, undefined);
  assert.equal(h.calls.length, 0);
});

test('all-invalid imports complete with correct failed counts and worker progress', async () => {
  const h = importer(false, true), progress = [];
  const result = await h.run(async value => progress.push(value));
  assert.equal(result.imported, 0);
  assert.equal(result.failed, 2);
  assert.equal(h.result.progress.processed_rows, 2);
  assert.equal(h.result.progress.failed_rows, 2);
  assert.deepEqual(progress, [100]);
});

test('retry after a progress failure reuses the list and existing contacts without consuming their plan slots again', async () => {
  const h = importer(false, false, true);
  await assert.rejects(h.run(), /Progress write failed/);
  const result = await h.run();
  assert.equal(h.result.listCreations, 1);
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.equal(h.calls.length, 3);
  assert.equal(h.result.tagCountCalls, 1);
});
