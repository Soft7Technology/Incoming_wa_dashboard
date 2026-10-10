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
        if (id === '@surefy/server') return () => {};
        if (id.includes('reminderScheduler.service')) return { start() {} };
        const worker = { name: 'test-worker', opts: { concurrency: 1 } };
        return { contactImportWorker: worker, campaignExecutionWorker: worker,
          bulkMessageSendWorker: worker, chatbotDelayWorker: worker };
      },
    });
    assert.equal(loaded[0], 'dotenv/config');
  });
}
