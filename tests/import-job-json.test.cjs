const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('import job update serializes JSONB arrays before calling BaseModel', async () => {
  let received;
  class BaseModel {
    constructor() {}
    async update(id, data) { received = { id, data }; return data; }
  }
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync('src/app/models/importJob.model.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, require: () => ({ BaseModel }) });

  await exports.default.update('job-1', {
    list_id: 'list-1',
    total_rows: 2,
    file_headers: ['Name', 'Phone'],
    errors: [{ row: 2, error: 'invalid' }],
  });

  assert.equal(received.id, 'job-1');
  assert.equal(received.data.file_headers, '["Name","Phone"]');
  assert.equal(received.data.errors, '[{"row":2,"error":"invalid"}]');
  assert.equal(received.data.list_id, 'list-1');
  assert.equal(received.data.total_rows, 2);
});
