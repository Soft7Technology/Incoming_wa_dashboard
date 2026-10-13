const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Reproduce production Node/PM2 startup without the dev command's -r dotenv/config.
for (const file of ['src/server.ts', 'src/workers/index.ts']) {
  test(`${file} loads .env before dependencies create Redis or database clients`, () => {
    const env = {}, loaded = [];
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(js, {
      exports: {}, process: { env, pid: 1, once() {} }, console: { info() {} },
      require(id) {
        loaded.push(id);
        if (id === 'dotenv/config') { env.REDIS_DB = '3'; return {}; }
        assert.equal(env.REDIS_DB, '3', `${id} loaded before environment configuration`);
        if (file === 'src/workers/index.ts') assert.equal(env.WORKER_MODE, 'true');
        if (id === '@surefy/server') return () => {};
        if (id.includes('reminderScheduler.service')) return { start() {} };
        const worker = { name: 'test-worker', opts: { concurrency: 1 } };
        return { contactImportWorker: worker, campaignExecutionWorker: worker,
          bulkMessageSendWorker: worker, chatbotDelayWorker: worker, mediaUploadWorker: worker };
      },
    });
    assert.equal(loaded[0], 'dotenv/config');
  });
}

test('combined worker starts all consumers and drains every job and scheduler before closing connections', async () => {
  const signals = {}, calls = [], env = {};
  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }
  const workerDrains = [], schedulerDrain = deferred();
  const processors = {
    'contactImport.processor': ['contactImportWorker', 'contact-import'],
    'campaignExecution.processor': ['campaignExecutionWorker', 'campaign-execution'],
    'bulkMessageSend.processor': ['bulkMessageSendWorker', 'bulk-message-send'],
    'chatbotDelay.processor': ['chatbotDelayWorker', 'chatbot-delay'],
    'mediaUpload.processor': ['mediaUploadWorker', 'media-upload'],
  };
  let started;
  const js = ts.transpileModule(fs.readFileSync('src/workers/index.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, {
    exports: {}, console: { info(message, details) { if (message === '[Workers] Started') started = details; }, error() {} },
    process: { env, pid: 1, once(signal, handler) { signals[signal] = handler; },
      exit(code) { calls.push(`exit:${code}`); } },
    require(id) {
      if (id === 'dotenv/config') return {};
      assert.equal(env.WORKER_MODE, 'true');
      const processor = processors[id.split('/').pop()];
      if (processor) {
        const [exportName, queueName] = processor;
        const drain = deferred();
        workerDrains.push(drain);
        return { [exportName]: { name: queueName, opts: { concurrency: 2 },
          close() { calls.push(queueName); return drain.promise; } } };
      }
      if (id.endsWith('/reminderScheduler.service')) return {
        start() { calls.push('scheduler-start'); },
        stop() { calls.push('scheduler-drain'); return schedulerDrain.promise; },
      };
      if (id.endsWith('/database')) return { destroy: async () => { calls.push('database'); } };
      if (id.endsWith('/redis.config')) return { redisConnection: { quit: async () => { calls.push('redis'); } } };
      if (id.endsWith('/mediaUpload.queue')) return { closeMediaUploadQueue: async () => { calls.push('media-queue'); } };
      if (id.endsWith('/contactImport.queue')) return { closeContactImportQueue: async () => { calls.push('contact-queue'); } };
      throw new Error(`Unexpected worker dependency: ${id}`);
    },
  });
  assert.deepEqual(Array.from(started.workers, worker => worker.name),
    ['contact-import', 'campaign-execution', 'bulk-message-send', 'chatbot-delay', 'media-upload']);
  assert.equal(workerDrains.length, 5);
  signals.SIGTERM();
  signals.SIGINT();
  const drainingCalls = ['scheduler-start', 'scheduler-drain',
    'contact-import', 'campaign-execution', 'bulk-message-send', 'chatbot-delay', 'media-upload'];
  assert.deepEqual(calls, drainingCalls);
  for (const drain of workerDrains) drain.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, drainingCalls);
  schedulerDrain.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [...drainingCalls, 'database', 'redis', 'media-queue', 'contact-queue', 'exit:0']);
});
