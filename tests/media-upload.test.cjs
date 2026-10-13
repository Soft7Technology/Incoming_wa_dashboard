const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Writable } = require('node:stream');
const express = require('express');
const multer = require('multer');
const { loadSource } = require('./helpers/background-database.cjs');

class HttpError extends Error {
  constructor(input, status = 400, _operational, details) {
    super(typeof input === 'string' ? input : input.message);
    this.statusCode = status; this.details = details;
  }
}
const codes = { OK: 200, ACCEPTED: 202, NOT_FOUND: 404, PAYLOAD_TOO_LARGE: 413, SERVICE_UNAVAILABLE: 503 };
const common = {
  '@surefy/utils/mediaUploadLimits': loadSource('library/surefy/src/utils/mediaUploadLimits.ts'),
  '@surefy/exceptions/CustomError': { CustomError: HttpError },
  '@surefy/exceptions/HTTP400Error': HttpError,
  '@surefy/exceptions/HTTP404Error': class extends HttpError { constructor(input) { super(input, 404); } },
  '@surefy/utils/HttpStatusCode': { HttpStatusCode: codes },
};

async function harness(t, { storageConfigured = true } = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'media-upload-test-'));
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('media-upload-test-'));
    await fs.promises.rm(target, { recursive: true, force: true });
  });
  const uploads = [], items = new Map(), jobs = new Map();
  let providerFailure = false, saveFailure = false, queueReady = true, enqueueFailure = false;
  const bucket = { name: 'test-bucket', file(fileName) { return {
    createWriteStream(options) {
      uploads.push({ fileName, options, bytes: 0 }); const upload = uploads.at(-1);
      return new Writable({ write(chunk, _encoding, done) {
        if (providerFailure) return done(Error('private provider diagnostics'));
        upload.bytes += chunk.length;
        this.emit('progress', { bytesWritten: upload.bytes }); done();
      } });
    },
  }; } };
  const env = storageConfigured ? { FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'test@example.invalid', FIREBASE_PRIVATE_KEY: 'fixture-key', FIREBASE_BUCKET: 'test-bucket' } : {};
  const admin = { apps: [], initializeApp() { this.apps.push({}); }, credential: { cert: data => data }, storage: () => ({ bucket: () => bucket }) };
  const globals = { process: { cwd: () => root, env }, AbortSignal };
  const utils = loadSource('src/app/utils/mediaUpload.ts', {
    ...common, 'node:fs': fs, 'node:path': path, 'node:stream/promises': require('node:stream/promises'), 'firebase-admin': admin,
  }, globals);
  const model = {
    findByIdAndUserId: async (id, userId) => items.get(id)?.user_id === userId ? items.get(id) : undefined,
    createForUpload: async data => {
      if (saveFailure) throw Object.assign(Error('database unavailable'), { code: '08006' });
      if (!items.has(data.id)) items.set(data.id, { ...data }); return items.get(data.id);
    },
  };
  const queue = {
    add: async (_name, data, options) => {
      if (enqueueFailure) throw Error('private queue diagnostics');
      const job = { id: options.jobId, data, attemptsMade: 0, opts: { attempts: 3 }, state: 'waiting', timestamp: Date.now(),
        updateProgress: async progress => { job.progress = progress; },
        getState: async () => job.state };
      jobs.set(job.id, job); return job;
    },
    getJob: async id => jobs.get(id),
  };
  const service = loadSource('src/app/services/mediaGalleryUpload.service.ts', {
    ...common, 'node:fs': fs, 'node:path': path, 'node:crypto': require('node:crypto'),
    '../models/mediaGallery.model': model, '../utils/mediaUpload': utils,
    '../../queues/mediaUpload.queue': { mediaUploadQueue: queue, ensureMediaQueueReady() { if (!queueReady) throw new HttpError('Queue unavailable', 503); } },
  }, globals);
  const file = async (size, originalname = 'photo.jpg') => {
    const folder = path.join(root, 'uploads'); await fs.promises.mkdir(folder, { recursive: true });
    const filePath = path.join(folder, require('node:crypto').randomUUID() + '.jpg');
    await fs.promises.writeFile(filePath, Buffer.alloc(size));
    return { size, path: filePath, originalname, mimetype: 'image/jpeg' };
  };
  return { root, service, utils, file, jobs, items, uploads, model, globals,
    providerFailure(value) { providerFailure = value; }, saveFailure(value) { saveFailure = value; },
    queueReady(value) { queueReady = value; }, enqueueFailure(value) { enqueueFailure = value; } };
}

for (const size of [3 * 1024 * 1024, 3 * 1024 * 1024 + 1]) {
  test(`gallery threshold routes ${size} bytes to the expected execution path`, async t => {
    const h = await harness(t), file = await h.file(size);
    const result = await h.service.startGalleryUpload('user', file, 'Photo');
    assert.equal(result.queued, size > 3 * 1024 * 1024);
    if (result.queued) {
      assert.equal(h.uploads.length, 0); assert.equal(h.items.size, 0);
      const job = h.jobs.get(result.job.job_id);
      assert.equal(job.data.userId, 'user'); assert.equal(job.data.size, size);
      assert.equal(Object.hasOwn(job.data, 'buffer'), false);
      assert.equal((await h.service.getGalleryUploadStatus('user', job.id)).status, 'queued');
      job.state = 'active'; assert.equal((await h.service.getGalleryUploadStatus('user', job.id)).status, 'processing');
      const item = await h.service.processGalleryUpload(job.data);
      assert.equal(item.name, 'Photo'); assert.equal(h.uploads[0].bytes, size);
      assert.equal(h.uploads[0].options.resumable, true);
      assert.equal(fs.existsSync(h.utils.stagedMediaPath(job.data)), false);
      h.queueReady(false);
      assert.equal((await h.service.getGalleryUploadStatus('user', job.id)).result.id, item.id);
    } else {
      assert.equal(result.item.name, 'Photo'); assert.equal(h.uploads.length, 1); assert.equal(h.jobs.size, 0);
      assert.equal(h.uploads[0].options.resumable, false);
    }
    assert.equal(fs.existsSync(file.path), false);
  });
}

test('Firebase failures reject instead of fabricating a successful media URL', async t => {
  const h = await harness(t); h.providerFailure(true);
  const file = await h.file(1024);
  await assert.rejects(h.service.startGalleryUpload('user', file), /Media storage upload failed/);
  assert.equal(h.items.size, 0); assert.equal(h.jobs.size, 0);
  assert.equal((await fs.promises.readdir(h.utils.MEDIA_UPLOAD_ROOT)).length, 0);
});

test('missing storage configuration returns an operational 503 and cleans the received file', async t => {
  const h = await harness(t, { storageConfigured: false }), file = await h.file(100);
  await assert.rejects(h.service.startGalleryUpload('user', file), error => error.statusCode === 503);
  assert.equal(fs.existsSync(file.path), false); assert.equal(h.items.size, 0);
});

test('offline queue fails before staging; uncertain enqueue retains the file and returns a recoverable job ID', async t => {
  const h = await harness(t), file = await h.file(3 * 1024 * 1024 + 1);
  h.queueReady(false);
  await assert.rejects(h.service.startGalleryUpload('user', file), error => error.statusCode === 503);
  assert.equal(fs.existsSync(file.path), false);
  h.queueReady(true); h.enqueueFailure(true);
  await assert.rejects(h.service.startGalleryUpload('user', await h.file(3 * 1024 * 1024 + 1)), error => {
    assert.equal(error.statusCode, 503); assert.ok(error.details.job_id);
    assert.equal(fs.existsSync(path.join(h.utils.MEDIA_UPLOAD_ROOT, error.details.job_id + '.jpg')), true); return true;
  });
});

test('retry after DB acknowledgement loss reuses the Firebase object/token and creates one gallery item', async t => {
  const h = await harness(t);
  const result = await h.service.startGalleryUpload('user', await h.file(3 * 1024 * 1024 + 1));
  const data = h.jobs.get(result.job.job_id).data;
  h.saveFailure(true);
  await assert.rejects(h.service.processGalleryUpload(data), error => error.code === '08006');
  assert.equal(fs.existsSync(h.utils.stagedMediaPath(data)), true);
  h.saveFailure(false); const item = await h.service.processGalleryUpload(data);
  assert.equal(h.uploads.length, 2); assert.equal(h.uploads[0].fileName, h.uploads[1].fileName);
  assert.equal(h.uploads[0].options.metadata.metadata.firebaseStorageDownloadTokens, h.uploads[1].options.metadata.metadata.firebaseStorageDownloadTokens);
  assert.equal(await h.service.processGalleryUpload(data), item);
  assert.equal(h.uploads.length, 2); assert.equal(h.items.size, 1);
});

test('job status enforces user ownership and does not expose provider failure details', async t => {
  const h = await harness(t);
  const result = await h.service.startGalleryUpload('owner', await h.file(3 * 1024 * 1024 + 1));
  const job = h.jobs.get(result.job.job_id);
  await assert.rejects(h.service.getGalleryUploadStatus('other', job.id), error => error.statusCode === 404);
  job.state = 'failed'; job.failedReason = 'private provider diagnostics';
  const status = await h.service.getGalleryUploadStatus('owner', job.id);
  assert.equal(status.status, 'failed'); assert.doesNotMatch(status.error, /private/);
  await assert.rejects(h.service.getGalleryUploadStatus('owner', '../other'), error => error.statusCode === 404);
});

test('staging validation prevents traversal and corrupted-size uploads', async t => {
  const h = await harness(t);
  const result = await h.service.startGalleryUpload('user', await h.file(3 * 1024 * 1024 + 1));
  const data = h.jobs.get(result.job.job_id).data;
  assert.throws(() => h.utils.stagedMediaPath({ ...data, stagedName: '../file.jpg' }), /Invalid/);
  await assert.rejects(h.utils.streamGalleryMedia({ ...data, size: data.size + 1 }), /size does not match/);
  assert.equal(h.uploads.length, 0);
});

test('worker limits concurrent uploads and retains files through retries, cleaning the final failure', async t => {
  const h = await harness(t);
  const result = await h.service.startGalleryUpload('user', await h.file(3 * 1024 * 1024 + 1));
  const job = h.jobs.get(result.job.job_id);
  h.providerFailure(true);
  const { mediaUploadWorker: worker } = loadSource('src/queues/processors/mediaUpload.processor.ts', {
    '../databaseAwareWorker': { createDatabaseAwareWorker(name, processor, opts) { return { name, processor, opts, on() {} }; } },
    '@surefy/config/redis.config': {}, '../../app/services/mediaGalleryUpload.service': h.service,
    '../../app/utils/mediaUpload': h.utils,
  }, { process: { pid: 1 } });
  assert.equal(worker.opts.concurrency, 1);
  await assert.rejects(worker.processor(job));
  assert.equal(fs.existsSync(h.utils.stagedMediaPath(job.data)), true);
  job.attemptsMade = 2; await assert.rejects(worker.processor(job));
  assert.equal(fs.existsSync(h.utils.stagedMediaPath(job.data)), false);
});

test('multipart HTTP upload responds 202, accepts polling, and responds 200 for small media', async t => {
  const h = await harness(t);
  const controller = loadSource('src/app/http/controllers/imageUpload.controller.ts', {
    ...common, '@surefy/console/models/mediaGallery.model': h.model,
    '../../services/mediaGalleryUpload.service': h.service,
    '@surefy/utils/Controller': { tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
      successResponse: (_req, res, message, data, status = 200) => res.status(status).json({ success: true, message, data }) },
  }).default;
  const middleware = loadSource('library/surefy/src/middleware/upload.middleware.ts', {
    ...common, multer, path, fs,
  }, h.globals).uploadMediaMiddleware;
  const router = loadSource('src/routes/imageUpload.route.ts', {
    express, '@surefy/middleware/upload.middleware': { uploadMediaMiddleware: middleware },
    '@surefy/console/http/controllers/imageUpload.controller': controller,
  }).default;
  const app = express(); app.use((req, _res, next) => { req.userId = 'user'; next(); });
  app.use('/uploads', express.static(path.join(h.root, 'uploads'), { dotfiles: 'ignore' }));
  app.use('/v1/admin/image-upload', router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const size of [1024, 3 * 1024 * 1024 + 1, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
    const form = new FormData(); form.append('file', new Blob([Buffer.alloc(size)], { type: 'image/jpeg' }), 'photo.jpg');
    const response = await fetch(base + '/v1/admin/image-upload/upload', { method: 'POST', body: form });
    assert.equal(response.status, size > 16 * 1024 * 1024 ? 413 : size > 3 * 1024 * 1024 ? 202 : 200);
    const body = await response.json();
    if (response.status === 413) {
      assert.equal(body.success, false); assert.equal(body.message, 'Upload Image under 16MB');
      assert.equal(h.jobs.size, 2); assert.equal(h.uploads.length, 1);
      assert.deepEqual((await fs.promises.readdir(path.join(h.root, 'uploads'))).filter(name => name !== '.media-upload'), []);
      continue;
    }
    assert.equal(body.success, true);
    if (response.status === 202) {
      assert.equal(response.headers.get('location'), body.data.status_url);
      assert.equal(response.headers.get('retry-after'), '2');
      const state = await fetch(base + body.data.status_url);
      assert.equal(state.headers.get('cache-control'), 'no-store');
      assert.equal((await state.json()).data.status, 'queued');
      const job = h.jobs.get(body.data.job_id);
      const stagedFile = await fetch(base + '/uploads/.media-upload/' + job.data.stagedName);
      assert.equal(stagedFile.status, 404);
    } else assert.ok(body.data.firebase_url);
  }
});

test('Multer oversized-file errors produce HTTP 413 rather than an unexpected 500', () => {
  const fakeMulter = Object.assign(() => ({ single: () => (_req, _res, callback) => callback(new multer.MulterError('LIMIT_FILE_SIZE')) }),
    { diskStorage: config => config, MulterError: multer.MulterError });
  const { uploadMediaMiddleware } = loadSource('library/surefy/src/middleware/upload.middleware.ts', {
    ...common, multer: fakeMulter, path, fs,
  }, { process: { cwd: () => os.tmpdir() } });
  let failure; uploadMediaMiddleware({}, {}, error => { failure = error; });
  assert.equal(failure.statusCode, 413); assert.match(failure.message, /50 MB/);
});

test('gallery service rejects oversized images with the requested message and cleans files without queueing', async t => {
  const h = await harness(t), file = await h.file(16 * 1024 * 1024 + 1);
  await assert.rejects(h.service.startGalleryUpload('user', file), error =>
    error.statusCode === 413 && error.message === 'Upload Image under 16MB');
  assert.equal(fs.existsSync(file.path), false); assert.equal(h.jobs.size, 0); assert.equal(h.uploads.length, 0);
  const document = await h.file(16 * 1024 * 1024 + 1, 'document.pdf'); document.mimetype = 'application/pdf';
  assert.equal((await h.service.startGalleryUpload('user', document)).queued, true);
});

test('worker rejects oversized staged images before opening a Firebase stream', async t => {
  const h = await harness(t), file = await h.file(16 * 1024 * 1024 + 1);
  const uploadId = require('node:crypto').randomUUID();
  const data = { uploadId, stagedName: uploadId + '.jpg', mimetype: file.mimetype, size: file.size };
  await fs.promises.mkdir(h.utils.MEDIA_UPLOAD_ROOT, { recursive: true });
  await fs.promises.rename(file.path, h.utils.stagedMediaPath(data));
  await assert.rejects(h.utils.streamGalleryMedia(data), error => error.statusCode === 413 && error.message === 'Upload Image under 16MB');
  assert.equal(h.uploads.length, 0);
});

test('image-specific error survives Multer limits when the rejected file is unavailable on req.file', () => {
  const fakeMulter = Object.assign(options => ({ single: () => (req, _res, callback) => {
    options.fileFilter(req, { mimetype: 'image/png' }, error => {
      assert.equal(error, null); callback(new multer.MulterError('LIMIT_FILE_SIZE'));
    });
  } }), { diskStorage: config => config, MulterError: multer.MulterError });
  const { uploadMediaMiddleware } = loadSource('library/surefy/src/middleware/upload.middleware.ts', {
    ...common, multer: fakeMulter, path, fs,
  }, { process: { cwd: () => os.tmpdir() } });
  let failure; uploadMediaMiddleware({}, {}, error => { failure = error; });
  assert.equal(failure.statusCode, 413); assert.equal(failure.message, 'Upload Image under 16MB');
});

test('queue bounds HTTP command waits and disconnects even when queue shutdown fails', async () => {
  let connection, queueOptions, disconnected = false;
  class Redis {
    constructor(options) { this.options = options; this.status = 'ready'; connection = this; }
    on() {}
    disconnect() { disconnected = true; }
  }
  class Queue {
    constructor(name, options) { assert.equal(name, 'media-upload'); queueOptions = options; }
    on() {}
    async close() { throw new Error('shutdown failure'); }
  }
  const module = loadSource('src/queues/mediaUpload.queue.ts', {
    ...common, bullmq: { Queue }, ioredis: Redis, '@surefy/config/redis.config': { host: 'test' },
  });
  assert.equal(connection.options.enableOfflineQueue, false);
  assert.equal(connection.options.autoResendUnfulfilledCommands, false);
  assert.equal(connection.options.commandTimeout, 5000);
  assert.equal(queueOptions.defaultJobOptions.attempts, 3);
  module.ensureMediaQueueReady();
  connection.status = 'reconnecting';
  assert.throws(module.ensureMediaQueueReady, error => error.statusCode === 503);
  await assert.rejects(module.closeMediaUploadQueue(), /shutdown failure/);
  assert.equal(disconnected, true);
});

test('terminal stalled failures clean the staged file, while retry failures retain it', async () => {
  const events = new Map(), removed = [];
  let cleanupDone;
  const module = loadSource('src/queues/processors/mediaUpload.processor.ts', {
    '../databaseAwareWorker': { createDatabaseAwareWorker() { return { on(name, callback) { events.set(name, callback); } }; } },
    '@surefy/config/redis.config': {}, '../../app/services/mediaGalleryUpload.service': {},
    '../../app/utils/mediaUpload': { async removeStagedMedia(data) { removed.push(data); cleanupDone?.(); } },
  }, { process: { pid: 1 } });
  const data = { uploadId: 'fixture' };
  events.get('failed')({ id: 'fixture', data }, new Error('retry'));
  assert.equal(removed.length, 0);
  await new Promise(resolve => {
    cleanupDone = resolve;
    events.get('failed')({ id: 'fixture', data, finishedOn: Date.now() }, new Error('stalled'));
  });
  assert.deepEqual(removed, [data]);
});

test('gallery insert compiles to an atomic ID conflict ignore and returns an existing owned record', async () => {
  const knex = require('knex')({ client: 'pg' });
  let statement;
  class BaseModel {
    constructor(table) { this.table = table; }
    query() {
      const query = knex(this.table);
      query.then = async callback => { statement = query.toSQL(); return callback([]); };
      return query;
    }
  }
  const model = loadSource('src/app/models/mediaGallery.model.ts', { '@surefy/models/base.model': { BaseModel } }).default;
  const row = { id: 'fixture', user_id: 'owner' };
  model.findByIdAndUserId = async (id, userId) => id === row.id && userId === row.user_id ? row : undefined;
  assert.equal(await model.createForUpload(row), row);
  assert.match(statement.sql, /on conflict \("id"\) do nothing/);
  await assert.rejects(model.createForUpload({ id: row.id, user_id: 'other' }), /no longer available/);
});

test('status API reports elapsed time, transfer progress and an estimate only for a fresh active transfer', async t => {
  const h = await harness(t);
  const result = await h.service.startGalleryUpload('owner', await h.file(4 * 1024 * 1024));
  const job = h.jobs.get(result.job.job_id), now = Date.now();
  job.timestamp = now - 10000; job.processedOn = now - 5000;
  job.progress = { stage: 'uploading', bytes_transferred: 2 * 1024 * 1024,
    upload_started_at: now - 5000, updated_at: now };
  let status = await h.service.getGalleryUploadStatus('owner', job.id);
  assert.equal(status.status, 'queued'); assert.equal(status.progress, 0);
  assert.equal(status.estimated_remaining_seconds, null);
  job.state = 'active';
  status = await h.service.getGalleryUploadStatus('owner', job.id);
  assert.equal(status.stage, 'uploading'); assert.equal(status.progress, 50);
  assert.equal(status.bytes_transferred, 2 * 1024 * 1024); assert.equal(status.total_bytes, 4 * 1024 * 1024);
  assert.ok(status.elapsed_seconds >= 10 && status.elapsed_seconds <= 11);
  assert.ok(status.processing_elapsed_seconds >= 5 && status.processing_elapsed_seconds <= 6);
  assert.ok(status.estimated_remaining_seconds >= 5 && status.estimated_remaining_seconds <= 6);
  job.progress.updated_at = now - 15000;
  assert.equal((await h.service.getGalleryUploadStatus('owner', job.id)).estimated_remaining_seconds, null);
  job.progress.stage = 'saving'; job.progress.bytes_transferred = job.data.size;
  status = await h.service.getGalleryUploadStatus('owner', job.id);
  assert.equal(status.progress, 99); assert.equal(status.estimated_remaining_seconds, null);
  job.state = 'failed'; job.finishedOn = now + 1000;
  status = await h.service.getGalleryUploadStatus('owner', job.id);
  assert.equal(status.stage, 'failed'); assert.equal(status.elapsed_seconds, 11);
  assert.equal(status.estimated_remaining_seconds, null);
  await h.service.processGalleryUpload(job.data);
  h.queueReady(false);
  status = await h.service.getGalleryUploadStatus('owner', job.id);
  assert.equal(status.status, 'completed'); assert.equal(status.progress, 100);
  assert.equal(status.estimated_remaining_seconds, 0);
});

test('Firebase stream emits byte progress and the service reports saving then completed', async t => {
  const h = await harness(t);
  const result = await h.service.startGalleryUpload('owner', await h.file(4 * 1024 * 1024));
  const data = h.jobs.get(result.job.job_id).data, events = [];
  await h.service.processGalleryUpload(data, (stage, bytes) => events.push({ stage, bytes }));
  const transfer = events.filter(event => event.stage === 'uploading');
  assert.ok(transfer.length > 1); assert.ok(transfer[0].bytes > 0);
  assert.equal(transfer.at(-1).bytes, data.size);
  assert.deepEqual(events.slice(-2).map(event => event.stage), ['saving', 'completed']);
});

test('worker coalesces progress writes, resets on a retry, and reporting failure cannot fail the upload', async () => {
  let clock = 10000;
  const item = { id: 'fixture' }, writes = [];
  const module = loadSource('src/queues/processors/mediaUpload.processor.ts', {
    '../databaseAwareWorker': { createDatabaseAwareWorker(_name, processor) { return { processor, on() {} }; } },
    '@surefy/config/redis.config': {},
    '../../app/services/mediaGalleryUpload.service': { async processGalleryUpload(data, report) {
      for (let bytes = 1; bytes <= data.size; bytes++) { clock += 100; report('uploading', bytes); }
      report('saving', data.size); report('completed', data.size); return item;
    } },
    '../../app/utils/mediaUpload': {},
  }, { process: { pid: 1 }, Date: { now: () => clock } });
  const job = { id: 'fixture', data: { size: 100 }, attemptsMade: 1, opts: { attempts: 3 },
    async updateProgress(snapshot) { writes.push(snapshot); await new Promise(resolve => setImmediate(resolve)); } };
  assert.equal(await module.mediaUploadWorker.processor(job), item);
  assert.equal(writes[0].bytes_transferred, 0);
  assert.equal(writes.at(-1).stage, 'completed'); assert.equal(writes.at(-1).bytes_transferred, 100);
  assert.ok(writes.length < 10, 'progress events must not generate a Redis write per chunk');
  job.updateProgress = async () => { throw Error('Redis unavailable'); };
  assert.equal(await module.mediaUploadWorker.processor(job), item);
});
