const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

test('PostgreSQL cancels runaway statements and keeps the bounded pool usable under load', {
  skip: !process.env.RUNTIME_HARDENING_DATABASE_URL, timeout: 15000,
}, async () => {
  const url = new URL(process.env.RUNTIME_HARDENING_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.ok(url.pathname.includes('runtime_hardening_test'));
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync('library/surefy/src/database/index.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, global: {}, console, process: {
    env: { NODE_ENV: 'test', DB_POOL_MAX: '2', DB_STATEMENT_TIMEOUT_MS: '100', DB_IDLE_TRANSACTION_TIMEOUT_MS: '500', WORKER_MODE: 'true' },
    on() {},
  }, require: id => id === '../config/knex.config'
    ? { __esModule: true, default: { test: { client: 'pg', connection: url.toString() } } } : require(id) });
  const db = exports.default;
  try {
    assert.equal((await db.raw('SHOW statement_timeout')).rows[0].statement_timeout, '100ms');
    assert.equal((await db.raw('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout, '500ms');
    assert.equal((await db.raw('SHOW application_name')).rows[0].application_name, 'soft7-worker');
    await assert.rejects(db.raw('SELECT pg_sleep(0.4)'), error => error.code === '57014');
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, db.client.pool.numUsed()); }, 2);
    try { await Promise.all(Array.from({ length: 40 }, () => db.raw('SELECT pg_sleep(0.01)'))); }
    finally { clearInterval(timer); }
    assert.ok(peak > 0 && peak <= 2, `bounded pool used ${peak} connections`);
    assert.equal((await db.raw('SELECT 1 AS healthy')).rows[0].healthy, 1);
  } finally { await db.destroy(); }
});
