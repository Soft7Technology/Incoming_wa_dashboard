const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/** Load production code with isolated dependencies; never open real background queues. */
function loadSource(file, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports, Buffer, Date, URL, URLSearchParams, TextEncoder, TextDecoder,
    process: { env: {} }, console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: path.dirname(path.resolve(file)), __filename: path.resolve(file),
    require: id => Object.hasOwn(dependencies, id) ? dependencies[id]
      : id.endsWith('/databaseErrors') ? databaseErrors
      : id.startsWith('.') || id.startsWith('@surefy/') ? {} : require(id),
    ...globals,
  }, { filename: file });
  return exports;
}

const databaseErrors = loadSource('library/surefy/src/utils/databaseErrors.ts');

/** Processor tests provide a fake BullMQ Worker instead of Redis connections. */
function processorFactory(dependencies) {
  return { createDatabaseAwareWorker: (name, processor, options) => new dependencies.bullmq.Worker(name, processor, options) };
}

module.exports = { loadSource, databaseErrors, processorFactory };
