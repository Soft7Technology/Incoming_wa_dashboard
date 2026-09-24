const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const knex = require('knex');

function load(file, deps) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, require: id => deps[id] || {}, Error, console: { log() {} } });
  return exports;
}
class HttpError extends Error { constructor(data) { super(data.message); } }
test('tag edits allow null/empty assignees while retaining team assignment authorization', async () => {
  let lookups = 0;
  const query = { join() { return this; }, where() { return this; }, whereNull() { return this; },
    async first() { lookups++; return undefined; } };
  const middleware = load('src/app/http/middleware/accountScope.ts', {
    '@surefy/database': () => query,
    '@surefy/exceptions/HTTP403Error': HttpError,
  });
  const req = { userId: 'owner', ownerId: 'owner', companyId: 'company', body: {} };
  for (const assigned_to of [undefined, null, [], 'owner']) {
    req.body = { assigned_to, assignedTo: null, tag_ids: ['tag'] };
    let error;
    await middleware.accountAssignments(req, {}, e => { error = e; });
    assert.equal(error, undefined);
  }
  assert.equal(lookups, 0);
  req.body.assigned_to = 'outside-user';
  let error;
  await middleware.accountAssignments(req, {}, e => { error = e; });
  assert.match(error.message, /must belong to your team/);
  assert.equal(lookups, 1);
  req.userId = 'member';
  req.body.assigned_to = null;
  await middleware.accountAssignments(req, {}, e => { error = e; });
  assert.match(error.message, /Only the account owner/);
});
function models() {
  const db = knex({ client: 'pg' });
  const queries = [];
  db.client.runner = builder => ({ run: async () => { queries.push(builder.toSQL()); return []; } });
  class BaseModel { constructor(table) { this.table = table; } query() { return db(this.table); } }
  const deps = { '@surefy/models/base.model': { BaseModel }, '@surefy/exceptions/HTTP400Error': HttpError };
  return { db, queries, model: name => load(`src/app/models/${name}.model.ts`, deps).default };
}

test('WABA and phone lists require both owner and company without OR fallback', async () => {
  const env = models();
  try {
    for (const name of ['waba', 'phoneNumber']) {
      const model = env.model(name);
      await model.findByUserId('owner-a', 'shared-company');
      const q = env.queries.at(-1);
      assert.ok(q.bindings.includes('owner-a') && q.bindings.includes('shared-company'));
      assert.ok(q.sql.includes('"user_id" = ?') && q.sql.includes('"company_id" = ?'));
      assert.ok(!q.sql.includes(' or '));
      await assert.rejects(model.findByUserId(undefined, 'shared-company'));
      await assert.rejects(model.findByUserId('owner-a', undefined));
    }
  } finally { await env.db.destroy(); }
});

test('phone filters and team assignments cannot replace contact ownership', async () => {
  const env = models();
  try {
    const contacts = env.model('contact');
    for (const filters of [{}, { onlyAssignedToUserId: 'member' }]) {
      const q = contacts.findWithFilters('owner-a', filters, 'phone').toSQL();
      assert.ok(q.sql.includes('"contacts"."user_id" = ?'));
      assert.ok(q.bindings.includes('owner-a') && q.bindings.includes('phone'));
      assert.ok(!q.sql.includes(' or '));
      if (filters.onlyAssignedToUserId) assert.ok(q.bindings.includes('member'));
    }
    await contacts.bulkDelete('company', ['contact'], 'owner-a', 'member');
    assert.deepEqual(env.queries.at(-1).bindings, ['company', 'owner-a', 'contact', 'member']);
    await assert.rejects(contacts.bulkDelete('company', ['contact'], undefined));
  } finally { await env.db.destroy(); }
});

test('phone access rejects a different owner in the same company and normalizes owned IDs', async () => {
  let phone = { id: 'internal', user_id: 'owner-b', company_id: 'company' };
  const middleware = load('src/app/http/middleware/accountScope.ts', {
    '../../models/phoneNumber.model': { findByPhoneNumberId: async () => phone },
    '@surefy/exceptions/HTTP403Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError,
  });
  const req = { userId: 'member', ownerId: 'owner-a', companyId: 'company', params: {}, body: { phone_number_id: 'meta' } };
  let error;
  await middleware.ownedPhone(req, {}, e => { error = e; });
  assert.match(error.message, /not found/);
  phone.user_id = 'owner-a';
  await middleware.ownedPhone(req, {}, e => { error = e; });
  assert.equal(error, undefined);
  assert.equal(req.body.phone_number_id, 'internal');
  phone.company_id = 'other-company';
  await middleware.ownedPhone(req, {}, e => { error = e; });
  assert.match(error.message, /not found/);
});

test('onboarding cannot transfer another owners WABA or call Meta first', async () => {
  let metaCalls = 0;
  const service = load('src/app/services/waba.service.ts', {
    '@surefy/console/models/waba.model': { findByWabaId: async () => ({ user_id: 'owner-b', company_id: 'company' }) },
    '@surefy/console/services/meta.service': { getWabaDetails: async () => { metaCalls++; } },
    '@surefy/exceptions/HTTP400Error': HttpError,
  }).default;
  await assert.rejects(service.upsertWaba({ user_id: 'owner-a', company_id: 'company', waba_id: 'meta' }), /another account/);
  assert.equal(metaCalls, 0);
});

test('incoming contacts reuse only the owner, company, and phone identity', async () => {
  const env = models();
  try {
    const contacts = env.model('contact');
    let creates = 0;
    const data = { user_id: 'owner', company_id: 'company', phone_number_id: 'phone', phone_number: '+919372597458' };
    const existing = { id: 'existing' };
    contacts.findOwnedByPhone = async (...args) => {
      assert.deepEqual(args, ['owner', '+919372597458', 'phone', 'company']);
      return existing;
    };
    contacts.create = async () => { creates++; return { id: 'new' }; };
    assert.equal(await contacts.findOrCreateIncoming(data), existing);
    assert.equal(creates, 0);
    contacts.findOwnedByPhone = async () => undefined;
    assert.equal((await contacts.findOrCreateIncoming(data)).id, 'new');
    assert.equal(creates, 1);
    await assert.rejects(contacts.findOrCreateIncoming({ ...data, company_id: undefined }));
  } finally { await env.db.destroy(); }
});
