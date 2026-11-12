const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register');
const { parseImportedPhone } = require('../src/app/utils/importPhone');
const { canonicalPhone, contactPlan, templatePlan, normalizeIndex } = require('../scripts/reconcile-legacy-database.cjs');
test('repair preserves unresolved digits without guessing a country and retains invalid flags', () => {
  assert.deepEqual(canonicalPhone({ id: 'a', phone_number: '6581234567', country_code: null }, parseImportedPhone),
    { phone_number: '+6581234567', country_code: null, is_valid: false });
  assert.deepEqual(canonicalPhone({ id: 'b', phone_number: '+12345', country_code: '1' }, parseImportedPhone),
    { phone_number: '+12345', country_code: null, is_valid: false });
  assert.deepEqual(canonicalPhone({ id: 'c', phone_number: '81234567', country_code: '65', is_valid: false }, parseImportedPhone),
    { phone_number: '+6581234567', country_code: '65', is_valid: false });
  assert.throws(() => canonicalPhone({ id: 'd', phone_number: 'unknown' }, parseImportedPhone), /manual review/);
  assert.deepEqual(canonicalPhone({ id: 'legacy', phone_number: '+' + '1'.repeat(40) }, parseImportedPhone),
    { phone_number: '+' + '1'.repeat(40), country_code: null, is_valid: false });
});
test('contact repair keeps ownership boundaries and preserves opt-out on the active keeper', () => {
  const base = { company_id: 'c', user_id: 'u', phone_number_id: 'p', country_code: '65', is_valid: true, is_opted_out: false, deleted_at: null };
  const rows = [{ ...base, id: 'old', phone_number: '+6581234567' },
    { ...base, id: 'copy', phone_number: '81234567', is_opted_out: true },
    { ...base, id: 'other-owner', user_id: 'v', phone_number: '+6581234567' },
    { ...base, id: 'archived', phone_number: '+6581234567', deleted_at: '2020-01-01' }];
  const before = JSON.stringify(rows);
  const plan = contactPlan(rows, parseImportedPhone);
  assert.deepEqual(plan.archive, [{ contact_id: 'copy', keeper_id: 'old' }]);
  assert.equal(plan.changes.find(r => r.id === 'old').is_opted_out, true);
  assert.equal(plan.changes.find(r => r.id === 'copy').archive, true);
  assert.equal(plan.changes.some(r => r.id === 'other-owner'), false);
  assert.equal(JSON.stringify(rows), before);
});
test('template repair requires exact provider identity within each WABA', () => {
  const a = { id: 'keeper', company_id: 'c', waba_id: 'w', name: 'hello', language: 'en', template_id: '123' };
  assert.deepEqual(templatePlan([a, { ...a, id: 'copy' }]).archive, [{ template_id: 'copy', keeper_id: 'keeper' }]);
  assert.equal(templatePlan([a, { ...a, id: 'other', waba_id: 'other' }]).archive.length, 0);
  assert.throws(() => templatePlan([a, { ...a, id: 'different', template_id: '456' }]), /Conflicting Meta template IDs/);
});
test('index validation tolerates PostgreSQL formatting but retains uniqueness and scope', () => {
  const sql = "CREATE UNIQUE INDEX x ON contacts (company_id, user_id, (COALESCE(phone_number_id::text, '')), phone_number) WHERE deleted_at IS NULL";
  const actual = "CREATE UNIQUE INDEX x ON public.contacts USING btree (company_id, user_id, COALESCE((phone_number_id)::text, ''::text), phone_number) WHERE (deleted_at IS NULL)";
  assert.equal(normalizeIndex(sql), normalizeIndex(actual));
  assert.notEqual(normalizeIndex(sql), normalizeIndex(sql.replace('UNIQUE ', '')));
  assert.notEqual(normalizeIndex(sql), normalizeIndex(sql.replace('user_id, ', '')));
});

test('compiled migrations use the same ledger names as source migrations and ignore source maps', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
  const code = ts.transpileModule(fs.readFileSync('library/surefy/src/config/knex.config.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const evaluate = compiled => {
    const exports = {}, loaded = [];
    const root = path.resolve('tmp', 'migration-fixture', ...(compiled ? ['dist'] : []));
    vm.runInNewContext(code, { exports, __dirname: path.join(root, 'library/surefy/src/config'), process: { env: {} },
      require: name => {
        if (name === 'dotenv') return { config() {} };
        if (name === 'node:fs/promises') return { readdir: async () => compiled ? ['002_second.js.map', '002_second.js', '001_first.js'] : ['002_second.ts', 'types.d.ts', '001_first.ts'] };
        if (path.isAbsolute(name)) { loaded.push(name); return { up() {}, down() {} }; }
        return require(name);
      },
    });
    const config = exports.default.production;
    const db = require('knex')({ ...config, connection: undefined });
    const merged = db.migrate.config.migrationSource;
    if (compiled) assert.equal(merged, config.migrations.migrationSource);
    return { source: config.migrations.migrationSource, directory: config.migrations.directory, loaded, root };
  };
  const source = evaluate(false), compiled = evaluate(true);
  const compiledFiles = await compiled.source.getMigrations();
  assert.equal(source.directory, path.join(source.root, 'src/database/migrations'));
  assert.deepEqual(Array.from(compiledFiles, f => compiled.source.getMigrationName(f)), ['001_first.ts', '002_second.ts']);
  assert.equal(typeof (await compiled.source.getMigration(compiledFiles[0])).up, 'function');
  assert.equal(compiled.loaded[0], path.join(compiled.root, 'src/database/migrations/001_first.js'));
});
