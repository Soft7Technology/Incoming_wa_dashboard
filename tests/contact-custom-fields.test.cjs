const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadParser() {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync('src/app/utils/contactCustomFields.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  class HTTP400Error extends Error { constructor(data) { super(data.message); } }
  vm.runInNewContext(js, { exports, require: () => HTTP400Error, JSON });
  return exports.parseContactCustomFields;
}

test('contact custom fields accept an object or JSON object string', () => {
  const parse = loadParser();
  assert.deepEqual(JSON.parse(JSON.stringify(parse({ city: 'Pune' }, 'custom_fields'))), { city: 'Pune' });
  assert.deepEqual(JSON.parse(JSON.stringify(parse('{"tier":"gold"}', 'custom_fields'))), { tier: 'gold' });
});

test('contact custom fields reject malformed JSON and non-object JSON', () => {
  const parse = loadParser();
  assert.throws(() => parse('{bad', 'custom_fields'), /must be valid JSON/);
  assert.throws(() => parse('[1,2]', 'custom_fields'), /must be a JSON object/);
  assert.throws(() => parse(null, 'custom_fields'), /must be a JSON object/);
});
