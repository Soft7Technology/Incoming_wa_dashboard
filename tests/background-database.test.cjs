const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadSource, databaseErrors, backgroundDatabase } = require('./helpers/background-database.cjs');
const { BackgroundDatabaseGate, checkDatabaseSchema } = backgroundDatabase;
const flush = () => new Promise(resolve => setImmediate(resolve));
const schemaError = () => Object.assign(new Error('select secret bindings'), { code: '42P01', detail: 'private data' });

test('database classification handles nested and cyclic errors without treating row constraints as outages', () => {
  for (const code of ['42P01', '42703', '53300', '57P03', '08006', '42501']) {
    assert.equal(databaseErrors.getDatabaseFailure({ cause: { code } }).code, code);
  }
  const cycle = {}; cycle.cause = cycle;
  assert.equal(databaseErrors.getDatabaseFailure(cycle), undefined);
  for (const code of ['23505', '23503', '23514']) assert.equal(databaseErrors.getDatabaseFailure({ code }), undefined);
  assert.equal(databaseErrors.getDatabaseFailure({ name: 'KnexTimeoutError' }).code, 'DB_POOL_TIMEOUT');
});

test('repeated database logs are bounded and omit SQL, bindings, details and credentials', () => {
  let now = 0; const logs = [];
  const errors = loadSource('library/surefy/src/utils/databaseErrors.ts', {}, {
    Date: { now: () => now }, console: { error: (...args) => logs.push(args) },
  });
  const failure = schemaError();
  for (let i = 0; i < 100; i++) errors.reportBackgroundError('test worker', failure);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /secret|private data|select/);
  now = 60000; errors.reportBackgroundError('test worker', failure);
  assert.equal(logs.length, 2);
});

test('schema outages back off from 30 seconds to five minutes, then recover automatically', async () => {
  let now = 0, queries = 0, unavailable = true;
  const gate = new BackgroundDatabaseGate('test gate', () => now);
  const probe = async () => { queries++; if (unavailable) throw schemaError(); };
  let previousQueries = 0;
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    assert.equal(await gate.check(probe), false);
    assert.equal(queries, ++previousQueries);
    now += delay - 1;
    assert.equal(await gate.check(probe), false);
    assert.equal(queries, previousQueries);
    now++;
  }
  unavailable = false;
  assert.equal(await gate.check(probe), true);
  const healthyQueries = queries;
  assert.equal(await gate.check(probe), true);
  assert.equal(queries, healthyQueries);
});

test('schema checks share an in-flight query and a stale success cannot erase a runtime failure', async () => {
  let now = 0, finish, calls = 0;
  const gate = new BackgroundDatabaseGate('single flight', () => now);
  const probe = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = gate.check(probe), second = gate.check(probe);
  assert.equal(calls, 1);
  gate.fail(schemaError()); finish();
  assert.equal(await first, false); assert.equal(await second, false);
  assert.equal(await gate.check(async () => { calls++; }), false);
  now = 30000;
  assert.equal(await gate.check(async () => { calls++; }), true);
  assert.equal(calls, 2);
});

test('schema probes validate selected columns with zero rows and a query deadline', async () => {
  const calls = [];
  const db = table => ({ select(columns) { calls.push([table, Array.from(columns)]); return this; },
    limit(rows) { assert.equal(rows, 0); return this; },
    timeout(ms) { assert.equal(ms, 5000); return Promise.resolve([]); } });
  await checkDatabaseSchema(db, { campaigns: ['id', 'status'], reminders: ['status'] });
  assert.deepEqual(calls, [['campaigns', ['id', 'status']], ['reminders', ['status']]]);
});

function workerHarness() {
  let now = 0, missing = true, finishProbe;
  const timers = new Set(), probes = [];
  class FakeWorker extends EventEmitter {
    constructor(name, processor, options) { super(); Object.assign(this, { name, processor, opts: options, running: false, paused: false, runs: 0 }); }
    async run() {
      this.runs++; this.running = true;
      try { if (this.runFailure) throw this.runFailure; await new Promise(resolve => { this.finishRun = resolve; }); }
      finally { this.running = false; }
    }
    async pause(ignoreActive) { assert.equal(ignoreActive, true); this.paused = true; this.finishRun?.(); }
    resume() { this.paused = false; void this.run(); }
    isRunning() { return this.running; }
    isPaused() { return this.paused; }
  }
  const api = loadSource('src/queues/databaseAwareWorker.ts', {
    bullmq: { Worker: FakeWorker }, '@surefy/database': {},
    '../app/utils/backgroundDatabase': {
      BackgroundDatabaseGate: class extends BackgroundDatabaseGate { constructor(name) { super(name, () => now); } },
      checkDatabaseSchema: async (_db, requirements) => {
        probes.push(requirements);
        if (requirements.hold) await new Promise(resolve => { finishProbe = resolve; });
        if (requirements.campaigns && missing) throw schemaError();
      },
    },
  }, {
    setTimeout(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  return {
    create: requirements => api.createDatabaseAwareWorker('test', async () => {}, { connection: {} }, requirements),
    recover() { missing = false; }, probes,
    finishProbe: () => finishProbe(),
    async advance(ms) { now += ms; const pending = [...timers]; timers.clear(); pending.forEach(timer => timer.callback()); await flush(); },
    stop(worker) { worker.emit('closing'); worker.finishRun?.(); },
    timers,
  };
}

test('bad schema holds queued work before consumption while an independent worker runs, and recovery resumes it', async () => {
  const h = workerHarness();
  const campaign = h.create({ campaigns: ['id'] }), contact = h.create({ contacts: ['id'] });
  await flush();
  assert.equal(campaign.opts.autorun, false);
  assert.equal(campaign.runs, 0); assert.equal(campaign.isPaused(), true);
  assert.equal(contact.runs, 1);
  h.recover(); await h.advance(30000);
  assert.equal(campaign.runs, 1); assert.equal(contact.runs, 1);
  h.stop(campaign); h.stop(contact);
  assert.equal(h.timers.size, 0);
});

test('runtime database failure pauses further jobs and closing prevents a retry', async () => {
  const h = workerHarness(); h.recover(); const worker = h.create({ campaigns: ['id'] });
  await flush(); assert.equal(worker.runs, 1);
  worker.emit('failed', { id: 'job' }, schemaError());
  await flush(); assert.equal(worker.isPaused(), true); assert.equal(worker.isRunning(), false);
  h.stop(worker); await h.advance(30000); assert.equal(worker.runs, 1);
});

test('worker run rejection is handled and retried without an unhandled promise', async () => {
  const h = workerHarness(); h.recover(); const worker = h.create({ campaigns: ['id'] });
  worker.runFailure = schemaError(); await flush();
  assert.equal(worker.runs, 1); assert.equal(worker.isRunning(), false);
  worker.runFailure = undefined; await h.advance(30000);
  assert.equal(worker.runs, 2); h.stop(worker);
});

test('closing during schema validation cannot start a job afterwards', async () => {
  const h = workerHarness(); const worker = h.create({ hold: ['id'] });
  await flush(); h.stop(worker); h.finishProbe(); await flush();
  assert.equal(worker.runs, 0); assert.equal(h.timers.size, 0);
});

function schedulerHarness(kind) {
  let now = 0, ready = false, callback, ticks = 0;
  const fakeDatabase = {
    BackgroundDatabaseGate: class extends BackgroundDatabaseGate { constructor(name) { super(name, () => now); } },
    backgroundSchemas: { reminders: {}, 'campaign-execution': {} },
    checkDatabaseSchema: async () => { if (!ready) throw schemaError(); },
  };
  const dependencies = {
    'node-cron': { schedule(_expression, fn) { callback = fn; return { stop() {}, destroy() {} }; } },
    '@surefy/database': {}, '../utils/backgroundDatabase': fakeDatabase,
    './campaignRecovery': { reconcileFailedCampaignJobs: async () => { ticks++; } },
    '../models/campaign.model': { getScheduledCampaigns: async () => [] },
    '../models/reminder.model': {}, '../interfaces/reminder.interface': {}, './reminder.service': {},
    './message.service': {}, './contactOptOut.service': {}, '../utils/reminder': {}, './campaign.service': {},
  };
  const file = kind === 'reminders' ? 'src/app/services/reminderScheduler.service.ts' : 'src/app/services/campaignScheduler.service.ts';
  const scheduler = loadSource(file, dependencies).default;
  if (kind === 'reminders') scheduler.tick = async () => { ticks++; };
  scheduler.start();
  return { scheduler, callback: async () => { await callback(); await flush(); },
    time(value) { now = value; }, recover() { ready = true; }, get ticks() { return ticks; } };
}

for (const kind of ['reminders', 'campaigns']) {
  test(`${kind} scheduler skips database work during outage and resumes when schema is ready`, async () => {
    const h = schedulerHarness(kind);
    await h.callback(); h.time(10000); await h.callback(); assert.equal(h.ticks, 0);
    h.recover(); h.time(30000); await h.callback(); assert.equal(h.ticks, 1);
    await h.scheduler.stop(); await h.callback(); assert.equal(h.ticks, 1);
  });
}

test('API database errors return 503 without SQL details, and headers already sent are delegated', () => {
  const replies = [], headers = [];
  class CustomError extends Error {}
  const { errorHandler } = loadSource('library/surefy/src/middleware/errorHandler.ts', {
    '../exceptions/CustomError': { CustomError },
    '../utils/HttpStatusCode': { HttpStatusCode: { SERVICE_UNAVAILABLE: 503, INTERNAL_SERVER_ERROR: 500 } },
    '../utils/Response': { sendResponse: (...args) => { replies.push(args); } },
  }, { process: { env: { NODE_ENV: 'development' } } });
  const res = { setHeader: (...args) => headers.push(args) };
  errorHandler(schemaError(), {}, res, () => { throw Error('Unexpected next'); });
  assert.equal(replies[0][1], 503); assert.equal(replies[0][2], false);
  assert.deepEqual(headers, [['Retry-After', '30']]);
  assert.doesNotMatch(JSON.stringify(replies), /secret|select|private data/);
  let forwarded; errorHandler(schemaError(), {}, { headersSent: true }, error => { forwarded = error; });
  assert.equal(forwarded.code, '42P01'); assert.equal(replies.length, 1);
});
