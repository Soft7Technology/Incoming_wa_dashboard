const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

function load() {
  const queries = [];
  let domain = null;
  const db = table => ({
    where(scope) { queries.push({ table, scope }); return this; },
    whereIn(column, values) { queries.push({ column, values }); return this; },
    async first() { return domain; },
  });
  const exports = {};
  class Unauthorized extends Error {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/socketSession.service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, URL, process, require: id => id === '@surefy/database' ? db : Unauthorized });
  return { authorize: exports.authorizeSocketOrigin, queries, found(value) { domain = value; } };
}

test('shared socket origin keeps the verified user identity without a domain lookup', async () => {
  const { authorize, queries } = load();
  const session = await authorize('owner', 'company', 'https://app.soft7.in');
  assert.equal(session.userId, 'owner'); assert.equal(session.companyId, 'company'); assert.equal(queries.length, 0);
});
test('white-label origin must be active and belong to the authenticated company', async () => {
  const { authorize, queries, found } = load();
  await assert.rejects(authorize('owner', 'company-a', 'https://acer.soft7.in'));
  assert.deepEqual(JSON.parse(JSON.stringify(queries[0])), { table: 'company_domains', scope: { company_id: 'company-a', status: 'active' } });
  found({ id: 'registered-domain' });
  assert.equal((await authorize('owner', 'company-a', 'https://acer.soft7.in')).userId, 'owner');
  await assert.rejects(authorize('owner', undefined, 'https://acer.soft7.in'));
});
test('missing and malformed origins cannot create socket sessions', async () => {
  const { authorize } = load();
  for (const origin of [undefined, 'null', 'http://app.soft7.in', 'https://app.soft7.in/path', 'https://app.soft7.in:8443', 'https://attacker@app.soft7.in']) {
    await assert.rejects(authorize('owner', 'company', origin));
  }
});
