const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const express = require('express');
const { EventEmitter } = require('node:events');
const { loadSource, databaseErrors } = require('./helpers/background-database.cjs');
const timing = loadSource('src/app/utils/contactImportStatus.ts');
class HttpError extends Error { constructor(input, status = 404) { super(typeof input === 'string' ? input : input.message); this.statusCode = status; } }
function load(file, deps) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, console: { log() {}, error() {} }, require: id => {
    if (id.endsWith('/databaseErrors')) return databaseErrors;
    if (id === '../utils/contactImportStatus') return timing;
    if (id === '../utils/contactImportSummary') return loadSource('src/app/utils/contactImportSummary.ts');
    return deps[id] || {};
  } });
  return exports;
}
const jobId = '8a2b0b08-47b8-4a6b-8d64-320ceff5a3d4';
const now = 100000;
function record(overrides = {}) {
  return { id: jobId, user_id: 'owner', company_id: 'company', status: 'processing', total_rows: 2000,
    processed_rows: 1000, successful_rows: 990, failed_rows: 10, skipped_rows: 0, progress_percentage: 50,
    created_at: new Date(now - 30000), started_at: new Date(now - 20000),
    import_options: { execution_mode: 'worker', statistics: { valid_count: 1980, invalid_count: 10,
      needs_country_count: 10, importable_count: 1990, duplicate_count: 100, unique_count: 1890,
      created_count: 900, updated_count: 90 }, progress: { stage: 'importing', rows_processed: 1000,
      rows_total: 2000, processing_started_at: now - 10000, updated_at: now } }, ...overrides };
}
const active = { state: 'active', attemptsMade: 0, maxAttempts: 3 };

test('status includes row progress, elapsed seconds and average-rate ETA for a fresh active import', () => {
  const status = timing.contactImportStatus(record(), active, now);
  assert.equal(status.job_id, jobId); assert.equal(status.status, 'processing');
  assert.equal(status.progress, 50); assert.equal(status.remaining_rows, 1000);
  assert.equal(status.elapsed_seconds, 30); assert.equal(status.processing_elapsed_seconds, 20);
  assert.equal(status.estimated_remaining_seconds, 10); assert.equal(status.max_attempts, 3);
  assert.equal(status.valid_count, 1980); assert.equal(status.invalid_count, 10);
  assert.equal(status.duplicate_count, 100); assert.equal(status.created_count, 900); assert.equal(status.updated_count, 90);
});

test('queued/unparsed and historical jobs use null for unavailable statistics and preserve old result counts', () => {
  const queued = timing.contactImportStatus(record({ status: 'queued', import_options: {} }), null, now);
  assert.equal(queued.valid_count, null); assert.equal(queued.duplicate_count, null);
  const old = timing.contactImportStatus(record({ status: 'completed', import_options: {}, result: { invalid_count: 2, needs_country_count: 1 } }), null, now);
  assert.equal(old.invalid_count, 2); assert.equal(old.needs_country_count, 1);
  assert.equal(old.valid_count, null); assert.equal(old.duplicate_count, null);
  const zero = timing.contactImportStatus(record({ import_options: { statistics: { duplicate_count: 0, valid_count: 0 } } }), active, now);
  assert.equal(zero.duplicate_count, 0); assert.equal(zero.valid_count, 0);
});

test('unknown, queued, stale and saving states never invent a remaining-time estimate', () => {
  const stale = record(); stale.import_options.progress.updated_at = now - 10001;
  assert.equal(timing.contactImportStatus(stale, active, now).estimated_remaining_seconds, null);
  const saving = record(); saving.import_options.progress.stage = 'saving'; saving.progress_percentage = 100;
  const status = timing.contactImportStatus(saving, active, now);
  assert.equal(status.progress, 99); assert.equal(status.estimated_remaining_seconds, null);
  const queued = timing.contactImportStatus(record(), { ...active, state: 'waiting' }, now);
  assert.equal(queued.status, 'queued'); assert.equal(queued.estimated_remaining_seconds, null);
  assert.equal(queued.processing_elapsed_seconds, null);
  assert.equal(timing.contactImportStatus(record({ import_options: {} }), active, now).estimated_remaining_seconds, null);
});

test('pending retries expose queued/retrying rather than a terminal failed status', () => {
  const status = timing.contactImportStatus(record({ status: 'failed' }), { ...active, state: 'delayed', attemptsMade: 1 }, now);
  assert.equal(status.status, 'queued'); assert.equal(status.database_status, 'failed');
  assert.equal(status.stage, 'retrying'); assert.equal(status.retry_pending, true);
  assert.equal(status.poll_after_ms, 2000); assert.equal(status.estimated_remaining_seconds, null);
  const preparing = timing.contactImportStatus(record({ status: 'failed' }), active, now);
  assert.equal(preparing.stage, 'preparing'); assert.equal(preparing.progress, 0);
});

test('completed timings freeze at completion and terminal failures retain counts with unknown ETA', () => {
  const completed = timing.contactImportStatus(record({ status: 'completed', processed_rows: 2000, completed_at: new Date(now - 1000) }), null, now);
  assert.equal(completed.progress, 100); assert.equal(completed.remaining_rows, 0);
  assert.equal(completed.elapsed_seconds, 29); assert.equal(completed.estimated_remaining_seconds, 0);
  const failed = timing.contactImportStatus(record({ status: 'failed', failed_at: new Date(now - 1000) }), { ...active, state: 'failed' }, now);
  assert.equal(failed.status, 'failed'); assert.equal(failed.estimated_remaining_seconds, null);
  assert.equal(failed.retry_pending, false); assert.equal(failed.elapsed_seconds, 29);
});

function serviceHarness(job, queueLookup = async () => active, list) {
  return load('src/app/services/contact.service.ts', {
    '../models/importJob.model': { findById: async () => job,
      latestForLists: async (userId, companyId, ids) => job.user_id === userId && job.company_id === companyId && ids.includes(job.list_id) ? [job] : [] },
    '../models/contactList.model': { findByUserId: async (userId, companyId) =>
      list && list.user_id === userId && list.company_id === companyId ? [list] : [] },
    '@surefy/exceptions/HTTP404Error': HttpError,
    '../../queues/contactImport.queue': { getContactImportQueueStatus: queueLookup },
  }).default;
}

test('saved progress remains readable during a Redis outage and completed results never require Redis', async () => {
  const job = record();
  const service = serviceHarness(job, async () => { throw Error('Redis offline'); });
  const status = await service.getImportJobStatus(jobId, { userId: 'owner', companyId: 'company' });
  assert.equal(status.queue_status, 'unavailable'); assert.equal(status.successful_rows, 990);
  assert.equal(status.bull_job_state, null);
  assert.equal(status.duplicate_count, 100); assert.equal(status.valid_count, 1980);
  job.status = 'failed';
  const unknownRetry = await service.getImportJobStatus(jobId);
  assert.equal(unknownRetry.retry_pending, null); assert.equal(unknownRetry.poll_after_ms, 2000);
  job.status = 'completed'; job.result = { imported: 1990, failed: 10 };
  const done = await service.getImportJobStatus(jobId);
  assert.equal(done.queue_status, 'not_required'); assert.equal(done.result, job.result);
  assert.equal(done.estimated_remaining_seconds, 0);
});

test('status service rejects another owner/company or a deleted job before querying Redis', async () => {
  let reads = 0;
  const job = record(), service = serviceHarness(job, async () => { reads++; return active; });
  for (const scope of [{ userId: 'other', companyId: 'company' }, { userId: 'owner', companyId: 'other' }]) {
    await assert.rejects(service.getImportJobStatus(jobId, scope), error => error.statusCode === 404);
  }
  job.deleted_at = new Date();
  await assert.rejects(service.getImportJobStatus(jobId), error => error.statusCode === 404);
  assert.equal(reads, 0);
});

test('contact queue polls fail promptly offline, initial enqueue waits for ready, and connections close on shutdown failure', async () => {
  let producer, options, reads = 0, disconnected = false;
  class Redis extends EventEmitter { constructor(config) { super(); this.options = config; this.status = 'connecting'; producer = this; } disconnect() { disconnected = true; } }
  class Queue extends EventEmitter {
    constructor(_name, config) { super(); options = config; }
    async getJob() { reads++; return { getState: async () => 'active', attemptsMade: 1, opts: { attempts: 3 } }; }
    async close() { throw Error('close failed'); }
  }
  const queue = loadSource('src/queues/contactImport.queue.ts', {
    bullmq: { Queue }, ioredis: Redis, '@surefy/config/redis.config': {},
    '@surefy/exceptions/CustomError': { CustomError: HttpError }, '@surefy/utils/HttpStatusCode': { HttpStatusCode: { SERVICE_UNAVAILABLE: 503 } },
  }, { setTimeout, clearTimeout });
  assert.equal(producer.options.enableOfflineQueue, false); assert.equal(producer.options.commandTimeout, 5000);
  await assert.rejects(queue.getContactImportQueueStatus(jobId), error => error.statusCode === 503);
  assert.equal(reads, 0);
  const ready = queue.ensureContactImportQueueReady();
  producer.status = 'ready'; producer.emit('ready'); await ready;
  assert.equal(producer.listenerCount('ready'), 0);
  assert.equal((await queue.getContactImportQueueStatus(jobId)).attemptsMade, 1);
  producer.status = 'connecting';
  const failedInitialConnection = queue.ensureContactImportQueueReady();
  producer.emit('error', new Error('connection refused'));
  await assert.rejects(failedInitialConnection, error => error.statusCode === 503);
  assert.equal(producer.listenerCount('ready'), 0); assert.equal(producer.listenerCount('end'), 0);
  producer.status = 'reconnecting';
  await assert.rejects(queue.ensureContactImportQueueReady(), error => error.statusCode === 503);
  await assert.rejects(queue.closeContactImportQueue(), /close failed/); assert.equal(disconnected, true);
});

test('real contact status route returns progress with no caching and enforces account ownership', async t => {
  const job = record({ list_id: 'list', phone_number_id: 'phone' });
  job.import_options.statistics.duplicate_preview = [{ phone_number: '+447879543645', occurrences: 2, duplicate_rows: 1 }];
  job.import_options.statistics.needs_country_preview = [{ phone_number: '+9372597458', country_code: null, name: null }];
  const list = { id: 'list', user_id: 'owner', company_id: 'company', phone_number_id: 'phone',
    name: 'Imported list', total_contacts: 2000, valid_contacts: 1980, invalid_contacts: 10, file_headers: ['Phone Number'] };
  let queueReads = 0;
  const service = serviceHarness(job, async () => { queueReads++; return active; }, list);
  const scopes = load('src/app/http/middleware/accountScope.ts', {
    '@surefy/exceptions/HTTP404Error': HttpError,
    '@surefy/exceptions/HTTP403Error': class extends HttpError { constructor(input) { super(input, 403); } },
    '@surefy/database': () => { let filters; return { where(value) { filters = value; return this; }, whereNull() { return this; },
      first: async () => Object.entries(filters).every(([key, value]) => job[key] === value) ? job : undefined }; },
  });
  const controller = load('src/app/http/controllers/contact.controller.ts', {
    '@surefy/console/services/contact.service': service,
    '@surefy/utils/Controller': { tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
      successResponse: (_req, res, message, data) => res.json({ success: true, message, data }) },
  }).default;
  const noop = (_req, _res, next) => next();
  const route = load('src/routes/contact.route.ts', {
    express, '../app/http/middleware/accountScope': { ...scopes, ownedPhone: noop, accountAssignments: noop },
    '@surefy/middleware/upload.middleware': { uploadXLSXMiddleware: noop },
    '@surefy/middleware/plan.middleware': { checkPlanLimit: () => noop },
    '@surefy/middleware/jwtAuth.middleware': { requireRole: () => noop },
    '@surefy/console/http/controllers/contact.controller': controller,
    '../app/http/controllers/contactOptOut.controller': { getKeywords: noop, updateKeywords: noop, updateContact: noop },
  }).default;
  const app = express(); app.use((req, _res, next) => { req.userId = 'member'; req.ownerId = req.headers['x-test-owner']; req.companyId = 'company'; next(); });
  app.use('/v1/admin/contacts', route);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/v1/admin/contacts/import/${jobId}/status`;
  const response = await fetch(url, { headers: { 'x-test-owner': 'owner' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = (await response.json()).data; assert.equal(data.job_id, jobId); assert.equal(data.successful_rows, 990);
  assert.equal(data.duplicate_count, 100); assert.equal(data.invalid_count, 10); assert.equal(data.valid_count, 1980);
  const denied = await fetch(url, { headers: { 'x-test-owner': 'other' } }); assert.equal(denied.status, 404);
  const before = queueReads;
  const listsResponse = await fetch(url.split('/import/')[0] + '/lists', { headers: { 'x-test-owner': 'owner' } });
  assert.equal(listsResponse.status, 200);
  const lists = (await listsResponse.json()).data;
  assert.equal(lists.length, 1); assert.equal(lists[0].name, 'Imported list');
  assert.equal(lists[0].total_rows, 2000); assert.equal(lists[0].duplicate_count, 100);
  assert.equal(lists[0].needs_country_count, 10); assert.equal(lists[0].needs_country_preview[0].country_code, null);
  assert.equal(lists[0].duplicate_preview[0].occurrences, 2);
  assert.equal(queueReads, before, 'list statistics must not depend on Redis');
  const foreign = await fetch(url.split('/import/')[0] + '/lists', { headers: { 'x-test-owner': 'other' } });
  assert.deepEqual((await foreign.json()).data, []);
});
