const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadSource(file, dependencies = {}, globals = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, {
    exports,
    console: { info() {}, error() {}, warn() {}, log() {} },
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id.endsWith('/databaseErrors')) return databaseErrors;
      if (id.endsWith('/backgroundDatabase')) return backgroundDatabase;
      throw new Error(`Unexpected dependency: ${id}`);
    },
    ...globals,
  });
  return exports;
}
const databaseErrors = loadSource('library/surefy/src/utils/databaseErrors.ts');
const backgroundDatabase = loadSource('src/app/utils/backgroundDatabase.ts');
function processorFactory(dependencies) {
  return { createDatabaseAwareWorker: (name, processor, options) =>
    new dependencies.bullmq.Worker(name, processor, options) };
}
module.exports = { loadSource, databaseErrors, backgroundDatabase, processorFactory };
