require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, require: name => deps[name] || (name.includes('Error') ? HttpError : {}), console });
  return exports;
}
const parser = load('src/app/utils/contactCustomFields.ts');
function fixture() {
  const writes = [];
  const service = load('src/app/services/contact.service.ts', {
    '../utils/importPhone': require('../src/app/utils/importPhone'),
    '../utils/contactCustomFields': parser,
    './planUsage.service': { run: async (_user, _feature, callback) => callback({}) },
    '../models/contact.model': {
      findOwnedByPhone: async () => null,
      create: async data => { const contact = { ...data, id: 'contact' }; writes.push(contact); return contact; },
    },
  }).default;
  const controller = load('src/app/http/controllers/contact.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
    '@surefy/utils/HttpStatusCode': { HttpStatusCode: { CREATED: 201 } },
    '@surefy/console/services/contact.service': service,
    '../../models/activityLogs.model': { create: async () => {} },
  }).default;
  return { service, controller, writes };
}

test('contact creation API persists custom fields supplied as an object or JSON object string', async () => {
  const f = fixture();
  const values = [{ check: 'Hello', amount: 0, active: false }, { check: 'Welcome', amount: 12, active: true }];
  for (const [index, fields] of values.entries()) {
    const result = await f.controller.createContact({
      userId: 'member', ownerId: 'owner', companyId: 'company', headers: {}, socket: {},
      body: { phone_number: `+91937259745${index}`, phone_number_id: 'sender',
        attributes: { source: 'manual' }, custom_fields: index ? JSON.stringify(fields) : fields },
    }, {});
    assert.deepEqual(JSON.parse(JSON.stringify(result.custom_fields)), fields);
    assert.equal(result.user_id, 'owner');
    assert.equal(result.company_id, 'company');
    assert.equal(result.attributes.source, 'manual');
  }
  assert.equal(f.writes.length, 2);
});

test('invalid custom fields reject contact creation before persistence', async () => {
  for (const custom_fields of ['{broken', '[]', null, 1]) {
    const f = fixture();
    await assert.rejects(f.service.createContact('owner', 'company', {
      phone_number: '+919372597458', custom_fields,
    }), /custom_fields must/);
    assert.equal(f.writes.length, 0);
  }
});
