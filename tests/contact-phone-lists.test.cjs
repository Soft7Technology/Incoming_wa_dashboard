require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const express = require('express');
const { loadSource } = require('./helpers/background-database.cjs');
const HTTP400Error = require('../library/surefy/src/exceptions/HTTP400Error').default;
const HTTP404Error = require('../library/surefy/src/exceptions/HTTP404Error').default;
const phoneId = '23860277-69cd-44c2-b557-08f00ecaf2cf';
const metaId = '661886587013056';

function load(file, deps) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, require: name => deps[name] || {} });
  return exports;
}

test('phone-specific list queries and campaign selection queries scope owner, company, sender and deleted status', async () => {
  const knex = require('knex')({ client: 'pg' }), statements = [];
  knex.client.runner = builder => ({ run: async () => { statements.push(builder.toSQL()); return []; } });
  class BaseModel { constructor(table) { this.table = table; } query() { return knex(this.table); } }
  const lists = loadSource('src/app/models/contactList.model.ts', { '@surefy/models/base.model': { BaseModel } }).default;
  await lists.findByUserId('owner', 'company', phoneId);
  await lists.findSelectedForPhone('owner', 'company', phoneId, ['list-a', 'list-b']);
  for (const { sql, bindings } of statements) {
    assert.match(sql, /"user_id" = \?/); assert.match(sql, /"company_id" = \?/);
    assert.match(sql, /"phone_number_id" = \?/); assert.match(sql, /"deleted_at" is null/);
    for (const binding of ['owner', 'company', phoneId]) assert.ok(bindings.includes(binding));
  }
  assert.match(statements[0].sql, /order by "created_at" desc/);
  assert.match(statements[1].sql, /"id" in \(\?, \?\)/);
});

test('new HTTP list endpoint resolves Meta IDs and UUIDs, uses owner context, and rejects inaccessible senders', async t => {
  let phone = { id: phoneId, phone_number_id: metaId, user_id: 'owner', company_id: 'company' };
  let rows = [{ id: 'list', user_id: 'owner', company_id: 'company', phone_number_id: phoneId, name: 'Customers', total_contacts: 200 }];
  const reads = [];
  const service = load('src/app/services/contact.service.ts', {
    uuid: require('uuid'), '@surefy/exceptions/HTTP400Error': HTTP400Error, '@surefy/exceptions/HTTP404Error': HTTP404Error,
    '../models/phoneNumber.model': { findByPhoneNumberId: async id => { reads.push(['sender', id]); return phone; } },
    '../models/contactList.model': { findByUserId: async (...args) => { reads.push(['lists', ...args]); return rows; } },
    '../models/importJob.model': { latestForLists: async (...args) => { reads.push(['jobs', ...args]); return []; } },
    '../utils/contactImportSummary': loadSource('src/app/utils/contactImportSummary.ts'),
  }).default;
  const noop = (_req, _res, next) => next();
  const controller = load('src/app/http/controllers/contact.controller.ts', {
    '@surefy/console/services/contact.service': service,
    '@surefy/utils/Controller': { tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
      successResponse: (_req, res, message, data) => res.json({ success: true, message, data }) },
  }).default;
  const route = load('src/routes/contact.route.ts', {
    express, '@surefy/console/http/controllers/contact.controller': controller,
    '../app/http/middleware/accountScope': { accountScope: noop, ownedPhone: noop, ownedResource: () => noop, accountAssignments: noop },
    '@surefy/middleware/upload.middleware': { uploadXLSXMiddleware: noop },
    '@surefy/middleware/plan.middleware': { checkPlanLimit: () => noop },
    '@surefy/middleware/jwtAuth.middleware': { requireRole: () => noop },
    '../app/http/controllers/contactOptOut.controller': { getKeywords: noop, updateKeywords: noop, updateContact: noop },
  }).default;
  const app = express();
  app.use((req, _res, next) => { req.userId = 'member'; req.ownerId = 'owner'; req.companyId = 'company'; next(); });
  app.use('/v1/admin/contacts', route); app.use('/v1/api/contacts', route);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const get = (id, prefix = 'admin') => fetch(`http://127.0.0.1:${server.address().port}/v1/${prefix}/contacts/phone-number/${id}/lists`);
  for (const prefix of ['admin', 'api']) {
    for (const id of [metaId, phoneId]) {
      reads.length = 0;
      const response = await get(id, prefix); assert.equal(response.status, 200);
      const body = await response.json(); assert.equal(body.data[0].name, 'Customers');
      assert.equal(body.data[0].total_rows, 200);
      assert.deepEqual(reads[0], ['sender', id]);
      assert.deepEqual(reads[1], ['lists', 'owner', 'company', phoneId]);
      assert.equal(reads[2][0], 'jobs');
    }
  }
  for (const invalid of ['bad-id', 'undefined', 'null']) {
    reads.length = 0;
    const response = await get(invalid); assert.equal(response.status, 400); assert.equal(reads.length, 0);
  }
  const ownedPhone = phone;
  for (const inaccessible of [null, { ...ownedPhone, user_id: 'other' },
    { ...ownedPhone, company_id: 'other' }, { ...ownedPhone, deleted_at: new Date() }]) {
    phone = inaccessible; reads.length = 0;
    const response = await get(metaId); assert.equal(response.status, 404);
    assert.equal(reads.length, 1, 'inaccessible senders must not query lists');
  }
  phone = ownedPhone; rows = []; reads.length = 0;
  const empty = await get(metaId); assert.equal(empty.status, 200); assert.deepEqual((await empty.json()).data, []);
  assert.equal(reads.length, 2, 'empty lists must skip import job lookups');
});
