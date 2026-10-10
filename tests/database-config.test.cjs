const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

function source(file) {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

for (const compiled of [false, true]) {
  test(`${compiled ? 'compiled' : 'source'} database config loads project-root .env without moving migrations`, () => {
    const exports = {}, env = { NODE_ENV: 'production' }, loadedPaths = [];
    const directory = path.resolve(compiled ? 'dist/library/surefy/src/config' : 'library/surefy/src/config');
    vm.runInNewContext(source('library/surefy/src/config/knex.config.ts'), {
      exports, __dirname: directory, process: { env },
      require(id) {
        if (id === 'dotenv') return { config({ path: file }) {
          loadedPaths.push(file);
          if (file === path.resolve('.env')) env.DATABASE_URL = 'postgres://example.invalid/database';
        } };
        return require(id);
      },
    });
    assert.deepEqual(loadedPaths, [path.resolve('.env')]);
    assert.equal(exports.default.production.connection, env.DATABASE_URL);
    assert.equal(exports.default.production.migrations.directory,
      path.resolve(compiled ? 'dist/src/database/migrations' : 'src/database/migrations'));
  });
}

function database(connection, environment = 'production') {
  let initialized = 0;
  const exports = {};
  const context = {
    exports, global: {}, process: { env: { NODE_ENV: environment, WORKER_MODE: 'true' } }, console,
    require(id) {
      if (id === 'knex') return () => { initialized++; return {}; };
      if (id === 'pg') return { types: { builtins: { TIMESTAMP: 1114 }, setTypeParser() {} } };
      if (id === '../config/knex.config') return { production: { client: 'pg', connection } };
      throw new Error('Unexpected import: ' + id);
    },
  };
  return { run() { vm.runInNewContext(source('library/surefy/src/database/index.ts'), context); return exports.default; },
    initialized: () => initialized };
}

test('missing database configuration fails before a worker can run without a connection pool', () => {
  for (const connection of [undefined, '', '   ']) {
    const h = database(connection);
    assert.throws(() => h.run(), /DATABASE_URL is missing for production/);
    assert.equal(h.initialized(), 0);
  }
});

test('valid database configuration initializes the shared pool', () => {
  const h = database('postgres://example.invalid/database');
  h.run();
  assert.equal(h.initialized(), 1);
});

test('unsupported environment fails with a configuration error', () => {
  const h = database('postgres://example.invalid/database', 'unknown');
  assert.throws(() => h.run(), /Unsupported database environment: unknown/);
  assert.equal(h.initialized(), 0);
});
