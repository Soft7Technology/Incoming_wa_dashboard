const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const express = require('express');
const os = require('node:os'), path = require('node:path');
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: id => deps[id] || (id.startsWith('@surefy/') || id.startsWith('.') ? {} : require(id)) }, { filename: file });
  return exports;
}
async function serving(server, work) {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('nested Express 4 routes and middleware forward async errors during a concurrent burst', async () => {
  const { protectAsyncRoutes } = load('library/surefy/src/utils/asyncRouter.ts');
  const app = express(), router = express.Router(), nested = express.Router({ mergeParams: true });
  let errors = 0;
  nested.use(async (req, _res, next) => {
    await Promise.resolve(); if (req.query.middleware) throw Error('middleware failure'); next();
  });
  nested.get('/:id', async (req, res) => {
    await Promise.resolve(); if (Number(req.params.id) % 2) throw Error('route failure');
    res.json({ id: req.params.id, parent: req.params.parent });
  });
  nested.get('/skip/test', (_req, _res, next) => next('route'));
  nested.get('/skip/test', async (_req, res) => res.json({ skipped: true }));
  nested.get('/sync/test', () => { throw Error('sync failure'); });
  nested.use(async (error, _req, _res, _next) => { await Promise.resolve(); throw error; });
  router.use('/:parent', nested); protectAsyncRoutes(router); app.use('/api', router);
  app.get('/live', (_req, res) => res.json({ success: true }));
  app.use((error, _req, res, _next) => { errors++; res.status(400).json({ message: error.message }); });
  await serving(app.listen(0, '127.0.0.1'), async base => {
    const responses = await Promise.all(Array.from({ length: 100 }, (_, id) => fetch(`${base}/api/owner/${id}`)));
    assert.equal(responses.filter(r => r.status === 200).length, 50);
    assert.equal(responses.filter(r => r.status === 400).length, 50);
    assert.deepEqual(await responses[0].json(), { id: '0', parent: 'owner' });
    assert.equal((await fetch(`${base}/api/owner/2?middleware=true`)).status, 400);
    assert.equal((await fetch(`${base}/api/owner/sync/test`)).status, 400);
    assert.equal((await fetch(`${base}/api/owner/skip/test`)).status, 200);
    assert.equal(errors, 52);
    assert.equal((await fetch(`${base}/live`)).status, 200);
  });
});

test('worker liveness stays healthy while dependencies or workers are not ready', async () => {
  const { startWorkerHealth } = load('src/workers/health.ts');
  let ready = false, fail = false;
  await serving(startWorkerHealth(() => { if (fail) throw Error('Dependency unavailable'); return ready; }, 0), async base => {
    assert.equal((await fetch(`${base}/ready`)).status, 503);
    assert.equal((await fetch(`${base}/live`)).status, 200);
    ready = true;
    assert.equal((await fetch(`${base}/ready`)).status, 200);
    fail = true;
    assert.equal((await fetch(`${base}/ready`)).status, 503);
    assert.equal((await fetch(`${base}/live`)).status, 200);
  });
});

test('overload is rejected before work starts, health stays available, and disconnects free slots', async () => {
  const { requestCapacity } = load('library/surefy/src/middleware/requestCapacity.ts');
  const app = express(), release = [];
  app.use(requestCapacity(2));
  app.get('/work', (_req, res) => release.push(() => res.end('done')));
  app.post('/v1/admin/contacts/import', (_req, res) => release.push(() => res.end('imported')));
  app.get('/live', (_req, res) => res.end('up'));
  await serving(app.listen(0, '127.0.0.1'), async base => {
    const wait = async n => { while (release.length < n) await new Promise(resolve => setTimeout(resolve, 5)); };
    const abort = new AbortController();
    const first = fetch(`${base}/work`, { signal: abort.signal }).catch(() => null);
    const second = fetch(`${base}/work`); await wait(2);
    const rejected = await fetch(`${base}/work`);
    assert.equal(rejected.status, 503); assert.equal(rejected.headers.get('retry-after'), '1');
    assert.equal((await fetch(`${base}/live`)).status, 200);
    abort.abort(); await first;
    await new Promise(resolve => setTimeout(resolve, 30));
    const imported = fetch(`${base}/v1/admin/contacts/import`, { method: 'POST' }); await wait(3);
    release[1](); await second;
    assert.equal((await fetch(`${base}/v1/admin/contacts/import`, { method: 'POST' })).status, 503);
    release[2](); await imported;
    const next = fetch(`${base}/work`); await wait(4); release[3](); assert.equal((await next).status, 200);
  });
});

test('concurrent readiness requests share a bounded probe and never disclose database errors', async () => {
  let probes = 0, complete;
  const router = load('library/surefy/src/routes/health.route.ts', {
    '../database': { raw: () => { probes++; return new Promise(resolve => { complete = resolve; }); } },
    '../utils/databaseErrors': { reportBackgroundError() {} },
  }).default;
  const app = express(); app.use('/health', router); app.get('/live', (_req, res) => res.end('up'));
  await serving(app.listen(0, '127.0.0.1'), async base => {
    const requests = Promise.all(Array.from({ length: 12 }, () => fetch(`${base}/health`)));
    while (!complete) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await fetch(`${base}/live`)).status, 200);
    const responses = await requests;
    assert.ok(responses.every(r => r.status === 503));
    assert.equal(probes, 1);
    assert.equal((await responses[0].json()).data.error, undefined);
    complete(); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal(probes, 1);
  });
});

test('production separates workers from API traffic and leaves database connection headroom', () => {
  const resources = JSON.parse(fs.readFileSync('deploy/kubernetes/production-runtime.json')).items;
  const api = resources.find(r => r.metadata.name === 'incoming-api' && r.kind === 'Deployment');
  const worker = resources.find(r => r.metadata.name === 'incoming-worker');
  const a = api.spec.template.spec.containers[0], w = worker.spec.template.spec.containers[0];
  assert.equal(api.spec.replicas, 2); assert.equal(worker.spec.replicas, 1);
  assert.equal(a.args[0], 'dist/src/server.js'); assert.equal(w.args[0], 'dist/src/workers/index.js');
  assert.notDeepEqual(api.spec.selector, worker.spec.selector);
  const setting = (container, key) => container.env.find(e => e.name === key).value;
  assert.equal(setting(a, 'WORKER_MODE'), 'false'); assert.equal(setting(w, 'WORKER_MODE'), 'true');
  assert.equal(2 * Number(setting(a, 'DB_POOL_MAX')) + Number(setting(w, 'DB_POOL_MAX')), 44);
  assert.equal(a.livenessProbe.httpGet.path, '/live'); assert.equal(w.livenessProbe.httpGet.path, '/live');
  assert.equal(w.readinessProbe.httpGet.path, '/ready');
  assert.equal(a.volumeMounts[0].mountPath, w.volumeMounts[0].mountPath);
  assert.ok(worker.spec.template.spec.terminationGracePeriodSeconds >= 150);
});

test('SQL timeouts become temporary service failures and campaigns defer safely', () => {
  const { getDatabaseFailure } = load('library/surefy/src/utils/databaseErrors.ts');
  const { isConnectionAcquireError } = load('src/queues/campaignDatabaseError.ts');
  for (const code of ['57014', '55P03', '25P03']) {
    const error = { cause: { code, message: 'private query and bindings' } };
    assert.equal(getDatabaseFailure(error).code, code);
    assert.equal(getDatabaseFailure(error).message.includes('private'), false);
    assert.equal(isConnectionAcquireError(error), true);
  }
  assert.equal(isConnectionAcquireError({ code: '23505' }), false);
});

test('Excel parsing rejects oversized expanded ranges and reads only the first worksheet', async () => {
  const XLSX = require('xlsx');
  const parser = load('src/app/services/xlsxParser.service.ts', {
    '../utils/importColumn': {}, '../utils/importPhone': {},
    '../utils/contactImportSummary': { detectImportPhoneColumn: headers => headers.find(h => h === 'phone') },
  }).default;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soft7-xlsx-bounds-'));
  const file = path.join(directory, 'test.xlsx');
  const write = (reference, second = false) => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([['phone'], ['919876543210']]);
    if (reference) sheet['!ref'] = reference;
    XLSX.utils.book_append_sheet(workbook, sheet, 'Contacts');
    if (second) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Unused'], ['Other data']]), 'Unused');
    XLSX.writeFile(workbook, file);
  };
  try {
    write(null, true);
    assert.equal((await parser.getFilePreview(file)).total_rows, 1);
    write('A1:A100002');
    await assert.rejects(parser.getFilePreview(file), /100000 data rows/);
    assert.equal((await parser.validateFile(file)).valid, false);
    write('A1:GS2'); // 201 columns.
    await assert.rejects(parser.getFilePreview(file), /200 columns/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('campaign shutdown yields its job before another batch and releases both locks', async () => {
  const { EventEmitter } = require('node:events');
  const { DelayedError } = require('bullmq');
  for (const immediate of [true, false]) {
    let checks = 0, released = 0, deleted = 0, deferred = 0, recipientReads = 0;
    const worker = new EventEmitter(); worker.opts = {};
    const errors = { getDatabaseFailure() {}, reportBackgroundError() {} };
    const exports = load('src/queues/processors/campaignExecution.processor.ts', {
      '../../workers/drain': { isWorkerDraining: () => immediate || ++checks > 1 },
      '../campaignExecution.queue': { campaignExecutionQueue: { client: Promise.resolve({
        set: async () => 'OK', eval: async () => { deleted++; return 1; },
      }) } },
      '../campaignCapacity': { campaignCapacity: {}, createCapacitySampler: () => ({ close() {} }) },
      '../databaseAwareWorker': { createDatabaseAwareWorker: () => worker },
      '@surefy/utils/databaseErrors': errors,
      '../campaignUserSlots': { acquireCampaignUserSlot: async () => true, releaseCampaignUserSlot: async () => { released++; } },
      '@surefy/console/models/campaign.model': { findById: async () => ({ status: 'running', user_id: 'owner', company_id: 'company', phone_number_id: 'phone' }) },
      '@surefy/console/models/template.model': { findById: async () => ({}) },
      '../../app/models/phoneNumber.model': { findByPhoneNumberId: async () => ({ user_id: 'owner', company_id: 'company', active: true }) },
      '@surefy/console/models/campaignMessage.model': { getPendingMessages: async () => { recipientReads++; return []; } },
    });
    try {
      await assert.rejects(exports.processCampaignExecution({ data: { campaignId: 'campaign', companyId: 'company' },
        discard() {}, moveToDelayed: async (_time, token) => { assert.equal(token, 'token'); deferred++; },
      }, 'token'), error => error instanceof DelayedError);
      assert.equal(deferred, 1); assert.equal(recipientReads, 0);
      assert.equal(released, immediate ? 0 : 1); assert.equal(deleted, immediate ? 0 : 1);
    } finally { worker.emit('closed'); }
  }
});

test('bulk shutdown checkpoints completed recipients and resumes only the untouched remainder', async () => {
  const { EventEmitter } = require('node:events');
  const { DelayedError } = require('bullmq');
  let processor, options, draining = false;
  const sent = [];
  load('src/queues/processors/bulkMessageSend.processor.ts', {
    '../../workers/drain': { isWorkerDraining: () => draining },
    '../databaseAwareWorker': { createDatabaseAwareWorker: (_name, fn, opts) => { processor = fn; options = opts; return new EventEmitter(); } },
    '@surefy/utils/databaseErrors': { getDatabaseFailure() {}, reportBackgroundError() {} },
    '@surefy/console/app/models/user.model': { findById: async () => ({ id: 'owner' }) },
    '@surefy/console/services/message.service': { sendMessage: async message => {
      sent.push(message.to); if (sent.length === 50) draining = true; return { id: message.to };
    } },
  });
  let discarded = 0, deferred = 0;
  const job = { data: { userId: 'owner', messages: Array.from({ length: 52 }, (_, i) => ({ to: `recipient-${i}` })) },
    discard() { discarded++; }, async updateData(data) { job.data = structuredClone(data); }, async updateProgress() {},
    async moveToDelayed(_time, token) { assert.equal(token, 'token'); deferred++; },
  };
  await assert.rejects(processor(job, 'token'), error => error instanceof DelayedError);
  assert.equal(sent.length, 50); assert.equal(job.data.nextIndex, 50); assert.equal(job.data.result.successful, 50);
  draining = false;
  const result = await processor(job, 'token');
  assert.equal(result.successful, 52); assert.equal(new Set(sent).size, 52); assert.equal(sent.length, 52);
  assert.equal(discarded, 2); assert.equal(deferred, 1); assert.equal(options.maxStalledCount, 0);
});
