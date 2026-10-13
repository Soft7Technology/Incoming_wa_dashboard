const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const background = require('./helpers/background-database.cjs');
function load(file, deps, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => {
    if (id === './contactImport.service') throw Error('API must not execute the importer');
    if (id.endsWith('/databaseErrors')) return background.databaseErrors;
    if (id.endsWith('/databaseAwareWorker')) return background.processorFactory(deps);
    if (id === '../utils/contactImportStatus') return background.loadSource('src/app/utils/contactImportStatus.ts');
    if (id === '../utils/contactImportSummary') return background.loadSource('src/app/utils/contactImportSummary.ts');
    return deps[id] || {};
  }, process: { cwd: () => '/workspace' }, console: { log() {}, error() {} }, ...globals });
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
    '../../queues/contactImport.queue': { ensureContactImportQueueReady() {}, contactImportQueue: {
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
    '../../queues/contactImport.queue': { ensureContactImportQueueReady() {}, contactImportQueue: { add: async () => { throw Error('Redis unavailable'); } } },
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
  assert.equal(response.data.status_url, '/v1/admin/contacts/import/job/status');
  assert.equal(response.data.poll_after_ms, 2000);
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

function importer(fatal = false, allInvalid = false, failProgressOnce = false, rowDatabaseError = false, rowDuration = 0, fixtures = {}) {
  const calls = [], result = {};
  const contacts = new Map(fixtures.existing || []);
  const job = { id: 'job', user_id: 'owner', company_id: 'company', phone_number_id: 'phone', file_path: '/upload.xlsx', status: 'queued' };
  let savedList;
  let clock = 10000;
  const progressHistory = [];
  const deps = {
    path: require('node:path'),
    './planUsage.service': { run: async (owner, feature, create) => {
      calls.push([owner, feature]); return create('transaction');
    } },
    '@surefy/console/models/importJob.model': {
      findById: async () => job,
      getOrCreateContactList: async (_id, data) => {
        if (fixtures.failList) throw Error('List creation unavailable');
        if (!savedList) { savedList = { ...data, id: 'list' }; result.listCreations = (result.listCreations || 0) + 1; }
        return savedList;
      },
      updateStatus: async (_, _status, data) => { if (fatal) throw Error('database unavailable'); result.started = data; },
      update: async (_, data) => {
        if (data.import_options) job.import_options = JSON.parse(JSON.stringify(data.import_options));
      },
      updateProgress: async (_, data) => {
        if (failProgressOnce) { failProgressOnce = false; throw Error('Progress write failed'); }
        result.progress = data;
        progressHistory.push(data);
      },
      markAsCompleted: async (_, data) => { result.completed = data; job.status = 'completed'; job.result = data; },
      markAsFailed: async (_, error) => { result.failure = error.message; },
    },
    '@surefy/console/services/xlsxParser.service': {
      validateFile: async () => ({ valid: true }),
      parseContactsFromFile: async () => fixtures.parsed || (allInvalid ? ({
        headers: ['Phone'], valid: 0, invalid: 2, needs_country: 0,
        errors: [{ row: 2, error: 'Invalid phone' }, { row: 3, error: 'Invalid phone' }], contacts: [],
      }) : ({
        headers: ['Phone'], valid: 2, invalid: 0, needs_country: 0, errors: [],
        contacts: [{ phone_number: '111', country_code: '91' }, { phone_number: '222', country_code: '91' }],
      })),
    },
    '@surefy/console/models/contact.model': {
      findOwnedByPhone: async (_user, phone) => contacts.get(phone),
      update: async (id, data) => ({ id, ...data }),
      create: async (row, trx) => {
        clock += rowDuration;
        assert.equal(trx, 'transaction');
        assert.equal(row.source, 'import');
        if (rowDatabaseError) throw Object.assign(Error('column missing'), { code: '42703' });
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
  const processImport = load('src/app/services/contactImport.service.ts', deps, { Date: { now: () => clock } }).processContactImport;
  return { run: (updateProgress) => processImport({ jobId: 'job', userId: 'owner', companyId: 'company', phone_number_id: 'phone',
    country_code: '91', filePath: '/upload.xlsx', listName: 'List', options: { tagIds: ['tag'] } }, updateProgress), result, calls, job, progressHistory };
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
  assert.equal(result.valid_count, 2); assert.equal(result.invalid_count, 0);
  assert.equal(result.duplicate_count, 0); assert.equal(result.created_count, 1);
  assert.equal(result.updated_count, 0);
  assert.deepEqual(h.calls, [['owner', 'Contact'], ['owner', 'Contact']]);
});
test('fatal import failures persist failed status and reject for worker retry', async () => {
  const h = importer(true);
  await assert.rejects(h.run(), /database unavailable/);
  assert.equal(h.result.failure, 'database unavailable');
  assert.equal(h.result.completed, undefined);
});

test('database failure in a contact row aborts the import before processing further rows', async () => {
  const h = importer(false, false, false, true);
  await assert.rejects(h.run(), error => error.code === '42703');
  assert.equal(h.calls.length, 1);
  assert.equal(h.result.failure, 'column missing');
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
  assert.equal(result.valid_count, 0); assert.equal(result.invalid_count, 2);
  assert.equal(result.duplicate_count, 0); assert.equal(result.unique_count, 0);
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

test('slow rows publish progress inside a batch and retries reset old counters before parsing', async () => {
  const h = importer(false, false, false, false, 2100);
  await h.run();
  assert.equal(h.progressHistory[0].processed_rows, 1);
  assert.equal(h.progressHistory[0].successful_rows, 1);
  assert.equal(h.progressHistory[0].import_options.progress.stage, 'importing');
  assert.equal(h.progressHistory[0].import_options.progress.rows_processed, 1);
  assert.equal(h.progressHistory.at(-1).import_options.progress.stage, 'saving');
  assert.equal(h.result.started.processed_rows, 0);
  assert.equal(h.result.started.progress_percentage, 0);
  assert.equal(h.result.started.import_options.progress.stage, 'preparing');
});

function duplicateFixture() {
  return { headers: ['Phone'], valid: 3, invalid: 0, needs_country: 0, errors: [],
    contacts: Array.from({ length: 3 }, () => ({ phone_number: '+447879543645', country_code: '44' })) };
}

test('duplicate file rows remain successful updates and count only repetitions after the first occurrence', async () => {
  const h = importer(false, false, false, false, 0, { parsed: duplicateFixture() });
  const result = await h.run();
  assert.equal(result.valid_count, 3); assert.equal(result.duplicate_count, 2); assert.equal(result.unique_count, 1);
  assert.equal(result.created_count, 1); assert.equal(result.updated_count, 2);
  assert.equal(result.imported, 3); assert.equal(result.skipped, 0);
  assert.equal(h.result.progress.import_options.statistics.duplicate_count, 2);
  assert.equal(h.result.progress.import_options.statistics.created_count, 1);
});

test('saved contacts are reported as updates separately from duplicates within the file', async () => {
  const h = importer(false, false, false, false, 0, { parsed: duplicateFixture(),
    existing: [['+447879543645', { id: 'existing', phone_number: '+447879543645', country_code: '44' }]] });
  const result = await h.run();
  assert.equal(result.created_count, 0); assert.equal(result.updated_count, 3);
  assert.equal(result.duplicate_count, 2); assert.equal(h.calls.length, 0);
});

test('parsed statistics remain available when list creation fails before any contact can be imported', async () => {
  const h = importer(false, false, false, false, 0, { parsed: duplicateFixture(), failList: true });
  await assert.rejects(h.run(), /List creation unavailable/);
  assert.equal(h.job.import_options.statistics.valid_count, 3);
  assert.equal(h.job.import_options.statistics.duplicate_count, 2);
  assert.equal(h.job.import_options.statistics.created_count, 0);
  assert.equal(h.calls.length, 0);
});

test('file statistics stay stable across retries even when the first attempt created saved contacts', async () => {
  const h = importer(false, false, true, false, 0, { parsed: duplicateFixture() });
  await assert.rejects(h.run(), /Progress write failed/);
  const result = await h.run();
  assert.equal(result.duplicate_count, 2); assert.equal(result.valid_count, 3);
  assert.equal(result.unique_count, 1); assert.equal(result.created_count, 0); assert.equal(result.updated_count, 3);
  assert.equal(h.result.started.import_options.statistics, null);
  assert.equal(await h.run(), result);
});

test('real CSV normalization groups formatting variants and preserves invalid and unresolved-country counts', async () => {
  require('ts-node/register');
  const parser = require('../src/app/services/xlsxParser.service').default;
  const path = require('node:path'), os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-job-statistics-'));
  const file = path.join(directory, 'contacts.csv');
  try {
    fs.writeFileSync(file, 'Phone\n+447879543645\n447879543645\n9372597458\n9372597458\nabc\n');
    const parsed = await parser.parseContactsFromFile(file);
    const h = importer(false, false, false, false, 0, { parsed });
    const result = await h.run();
    assert.equal(result.total, 5); assert.equal(result.valid_count, 2); assert.equal(result.invalid_count, 1);
    assert.equal(result.needs_country_count, 2); assert.equal(result.importable_count, 4);
    assert.equal(result.duplicate_count, 2); assert.equal(result.unique_count, 2);
    assert.equal(result.created_count, 2); assert.equal(result.updated_count, 2);
    assert.equal(result.imported, 4); assert.equal(result.failed, 1);
    assert.equal(h.job.import_options.statistics.duplicate_count, 2);
    const preview = await parser.getValidatedPreview(file);
    for (const field of ['total_rows', 'detected_phone_column', 'selected_phone_column', 'valid_count', 'invalid_count', 'needs_country_count', 'importable_count', 'duplicate_count', 'unique_count']) {
      assert.equal(preview[field], result[field], `${field} must match between preview and import`);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(h.job.import_options.statistics.duplicate_preview)), preview.duplicate_preview);
    assert.deepEqual(JSON.parse(JSON.stringify(h.job.import_options.statistics.needs_country_preview)), preview.needs_country_preview);
  } finally { fs.unlinkSync(file); fs.rmdirSync(directory); }
});
