const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const knex = require('knex');
const express = require('express');
const http = require('node:http');

class HttpError extends Error {
  constructor({ message }) { super(message); }
}
function load(file, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, { exports, Date, require(name) {
    assert.ok(name in dependencies, name);
    return dependencies[name];
  } });
  return exports.default ?? exports;
}
const companyId = '87af00e3-cdf0-4c59-9950-143dbadf5ebc';
const userId = 'ae815512-cf4b-4e7e-8472-16d3c2d4bb18';
const otherId = 'c7d59a83-5d91-4b60-b463-c506ba148ec0';
const validation = load('src/app/utils/superAdminValidation.ts', {
  uuid: require('uuid'), '@surefy/exceptions/HTTP400Error': HttpError,
});
function service(model) {
  return load('src/app/services/superAdmin.service.ts', {
    bcrypt: {}, '../models/superAdmin.model': model,
    '../utils/superAdminValidation': validation,
    '@surefy/exceptions/HTTP400Error': HttpError, '@surefy/exceptions/HTTP403Error': HttpError,
  });
}

test('user collections validate IDs and filters before reads and URL scope overrides both query IDs', async () => {
  for (const resource of ['activities', 'campaigns', 'messages', 'contacts']) {
    const calls = [];
    const s = service({
      user: async (...args) => calls.push(args),
      collection: async (...args) => { calls.push(args); return { items: [] }; },
    });
    for (const [company, user, query] of [
      ['bad', userId, {}], [companyId, 'bad', {}], [companyId, userId, { user_id: 'bad' }],
      [companyId, userId, { company_id: 'bad' }], [companyId, userId, { page: '0' }],
      [companyId, userId, { limit: '101' }], [companyId, userId, { domain_status: 'active' }],
      [companyId, userId, { sort: 'password' }],
      [companyId, userId, { from: '2026-10-05', to: '2026-10-01' }],
    ]) await assert.rejects(s.userCollection(resource, query, company, user));
    assert.equal(calls.length, 0);
    await s.userCollection(resource, { company_id: otherId, user_id: otherId, page: '2', limit: '10' }, companyId, userId);
    assert.deepEqual(calls[0], [userId, companyId]);
    const [name, filters] = calls[1];
    assert.equal(name, resource);
    assert.equal(filters.company_id, companyId);
    assert.equal(filters.user_id, userId);
    assert.equal(filters.page, 2);
    assert.equal(filters.limit, 10);
    const missing = service({
      user: async () => { throw new HttpError({ message: 'User not found' }); },
      collection: () => assert.fail('must not list records for a missing user'),
    });
    await assert.rejects(missing.userCollection(resource, {}, companyId, userId), /User not found/);
  }
});

test('user overview and active plan validate both UUIDs before accessing the model', async () => {
  for (const method of ['userOverview', 'userActivePlan']) {
    let calls = 0;
    const s = service({ [method]: async (...args) => { calls++; assert.deepEqual(args, [companyId, userId]); } });
    assert.throws(() => s[method]('bad', userId), /companyId must be a UUID/);
    assert.throws(() => s[method](companyId, 'bad'), /userId must be a UUID/);
    assert.equal(calls, 0);
    await s[method](companyId, userId);
    assert.equal(calls, 1);
  }
});

function modelHarness(response) {
  const db = knex({ client: 'pg' });
  const queries = [];
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    queries.push(query);
    return response(builder._single.table, query, builder);
  } });
  class BaseModel { constructor() { this.db = db; } }
  const model = load('src/app/models/superAdmin.model.ts', {
    '@surefy/models/base.model': { BaseModel }, '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError, './subscription.model': {},
  });
  return { model, db, queries };
}

test('all user collection counts and pages use identical company, user and deletion filters', async () => {
  const h = modelHarness((table, query) => query.method === 'first' ? { total: '2' } : [{ id: 'record' }]);
  try {
    for (const [resource, table] of [
      ['activities', 'activity_logs'], ['campaigns', 'campaigns'], ['messages', 'messages'], ['contacts', 'contacts'],
    ]) {
      h.queries.length = 0;
      const result = await h.model.collection(resource, {
        company_id: companyId, user_id: userId, page: 2, limit: 10, search: 'Test%_',
        from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
      });
      assert.equal(result.pagination.total, 2);
      assert.equal(h.queries.length, 2);
      for (const q of h.queries) {
        assert.ok(q.sql.includes(`from "${table}"`));
        assert.match(q.sql, /"user_id" = \?/);
        assert.match(q.sql, /"company_id" = \?/);
        assert.ok(q.bindings.includes(companyId) && q.bindings.includes(userId));
        assert.match(q.sql, /"created_at" >= \? and "created_at" < \?/);
        assert.ok(q.bindings.includes('%Test\\%\\_%'));
        if (resource === 'messages') {
          assert.match(q.sql, /not "status" = \?/);
          assert.ok(q.bindings.includes('deleted'));
        } else assert.match(q.sql, /"deleted_at" is null/);
      }
      const page = h.queries.find(q => q.method === 'select');
      assert.match(page.sql, /order by "created_at" desc, "id" desc limit \? offset \?/);
      assert.deepEqual(page.bindings.slice(-2), [10, 10]);
      if (resource === 'contacts') {
        assert.match(page.sql, /"custom_fields", "is_valid", "invalid_reason", "is_opted_out"/);
        assert.doesNotMatch(page.sql, /"opted_out_at"|"opt_out_reason"/);
      }
    }
  } finally { await h.db.destroy(); }
});

test('user dashboard rejects missing/deleted companies, deleted users and users from another company before reading metrics', async () => {
  let company = { id: companyId }, user = { id: userId, company_id: companyId };
  const h = modelHarness((table, query) => {
    if (table === 'companies') return company;
    if (table === 'users') return user;
    assert.fail('invalid scope must stop before dashboard queries');
  });
  try {
    for (const method of ['userOverview', 'userActivePlan']) {
      company = undefined;
      await assert.rejects(h.model[method](companyId, userId), /Company not found/);
      company = { id: companyId };
      user = undefined;
      await assert.rejects(h.model[method](companyId, userId), /User not found/);
    }
    const companyQuery = h.queries.find(q => q.sql.includes('from "companies"'));
    assert.match(companyQuery.sql, /"id" = \? and "deleted_at" is null/);
    const userQuery = h.queries.find(q => q.sql.includes('from "users"'));
    assert.match(userQuery.sql, /"id" = \? and "deleted_at" is null and "company_id" = \?/);
    assert.deepEqual(userQuery.bindings.slice(0, 2), [userId, companyId]);
    assert.doesNotMatch(userQuery.sql, /"password"|"api_key"|"settings"/);
  } finally { await h.db.destroy(); }
});

test('user overview scopes messages and template WABA ownership and converts missing counts to zeros', async () => {
  let empty = false;
  const h = modelHarness(table => {
    if (table === 'companies') return { id: companyId };
    if (table === 'users') return { id: userId, company_id: companyId };
    if (table === 'messages') return empty ? {} : { total_message: '9', delivered_messages: '4', failed_messages: '1', received_messages: '2', message_templates: '5' };
    if (table === 'templates') return { total: empty ? '0' : '3' };
    assert.fail(table);
  });
  try {
    const result = await h.model.userOverview(companyId, userId);
    assert.equal(result.user.id, userId);
    assert.deepEqual(JSON.parse(JSON.stringify(result.stats)), {
      total_message: 9, delivered_messages: 4, failed_messages: 1, received_messages: 2, templates: 3, message_templates: 5,
    });
    const messages = h.queries.find(q => q.sql.includes('from "messages"'));
    assert.match(messages.sql, /"company_id" = \? and "user_id" = \? and not "status" = \?/);
    assert.deepEqual(messages.bindings.slice(0, 3), [companyId, userId, 'deleted']);
    const templates = h.queries.find(q => q.sql.includes('from "templates"'));
    assert.match(templates.sql, /"waba_id" in \(select "id" from "waba_accounts" where "company_id" = \? and "user_id" = \? and "deleted_at" is null\)/);
    assert.deepEqual(templates.bindings.slice(0, 3), [companyId, companyId, userId]);
    empty = true;
    assert.ok(Object.values((await h.model.userOverview(companyId, userId)).stats).every(count => count === 0));
  } finally { await h.db.destroy(); }
});

// Evaluate basic Knex predicates against plan fixtures so date/status exclusions are exercised.
function matchesBasicPredicates(row, builder) {
  return builder._statements.filter(s => s.grouping === 'where').every(s => {
    const value = s.value instanceof Date ? s.value.getTime() : s.value;
    const actual = s.value instanceof Date ? new Date(row[s.column]).getTime() : row[s.column];
    if (s.operator === '=') return actual === value;
    if (s.operator === '<=') return actual <= value;
    if (s.operator === '>') return actual > value;
    assert.fail(`Unsupported predicate: ${s.operator}`);
  });
}
test('active plan excludes stale active flags, wrong owners and invalid periods, and returns null when absent', async () => {
  const now = Date.now();
  const valid = {
    id: 'plan', company_id: companyId, user_id: userId, active: true, status: 'COMPLETED',
    start_date: new Date(now - 100000), end_date: new Date(now + 100000), limits: { Contact: 100 }, usage: { Contact: 5 },
  };
  let plan = valid;
  const h = modelHarness((table, query, builder) => {
    if (table === 'companies') return { id: companyId };
    if (table === 'users') return { id: userId, company_id: companyId, assigned_plan: 'stale-pointer' };
    if (table === 'user_plans') return plan && matchesBasicPredicates(plan, builder) ? plan : undefined;
    assert.fail(table);
  });
  try {
    assert.equal((await h.model.userActivePlan(companyId, userId)).active_plan.id, 'plan');
    for (const change of [
      { active: false }, { status: 'PENDING' }, { status: 'CANCELLED' }, { end_date: new Date(0) },
      { start_date: new Date(now + 100000) }, { company_id: otherId }, { user_id: otherId },
    ]) {
      plan = { ...valid, ...change };
      assert.equal((await h.model.userActivePlan(companyId, userId)).active_plan, null);
    }
    plan = null;
    assert.equal((await h.model.userActivePlan(companyId, userId)).active_plan, null);
    const q = h.queries.find(q => q.sql.includes('from "user_plans"'));
    assert.match(q.sql, /"company_id" = \? and "user_id" = \? and "active" = \? and "status" = \? and "start_date" <= \? and "end_date" > \?/);
    assert.deepEqual(q.bindings.slice(0, 4), [companyId, userId, true, 'COMPLETED']);
    assert.equal(q.bindings[4].getTime(), q.bindings[5].getTime());
    assert.match(q.sql, /"limits", "usage"/);
  } finally { await h.db.destroy(); }
});

function get(port, path, token) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers: token ? { authorization: token } : {} }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('all seven GET paths require JWT and superadmin authorization, pass URL IDs and preserve company resource routes', async () => {
  const calls = [];
  let activePlan = null;
  const helpers = {
    tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
    successResponse: (req, res, message, data) => res.json({ success: true, message, data }),
  };
  const controller = load('src/app/http/controllers/superAdmin.controller.ts', {
    '@surefy/utils/Controller': helpers, '@surefy/utils/HttpStatusCode': {},
    '../../services/superAdmin.service': {
      authorize: async id => { if (id !== 'superadmin') throw new HttpError({ message: 'Active superadmin access required' }); },
      userDetails: async (...args) => { calls.push(['details', ...args]); return { user: { id: userId } }; },
      userOverview: async (...args) => { calls.push(['overview', ...args]); return { stats: {} }; },
      userCollection: async (...args) => { calls.push(['collection', ...args]); return { items: [], pagination: { page: 2, limit: 25, total: 0 } }; },
      userActivePlan: async (...args) => { calls.push(['active-plan', ...args]); return { active_plan: activePlan }; },
      collection: async (...args) => { calls.push(['company-collection', ...args]); return { items: [] }; },
      companyOverview: async (...args) => { calls.push(['company-overview', ...args]); return {}; },
    },
  });
  const operations = load('src/app/http/controllers/superAdminOperations.controller.ts', {
    '@surefy/utils/Controller': helpers, '../../services/superAdminOperations.service': {},
  });
  const route = load('src/routes/superAdmin.route.ts', {
    express, '../app/http/controllers/superAdmin.controller': controller,
    '../app/http/controllers/superAdminOperations.controller': operations,
    '../app/http/controllers/superAdminUserPlan.controller': {
      availableForCompany: (req, res) => res.json({}), available: (req, res) => res.json({}),
      assign: (req, res) => res.json({}), details: (req, res) => res.json({}), changeStatus: (req, res) => res.json({}),
    },
    '@surefy/middleware/jwtAuth.middleware': { jwtAuthMiddleware(req, res, next) {
      if (!req.headers.authorization) return res.status(401).json({ message: 'JWT required' });
      req.userId = req.headers.authorization;
      next();
    } },
  });
  const app = express();
  app.use('/v1/super-admin', route);
  app.use((error, req, res, next) => res.status(403).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const base = `/v1/super-admin/companies/${companyId}/${userId}`;
    for (const [suffix, resource] of [
      ['', 'details'], ['/activity', 'activities'], ['/campaign', 'campaigns'], ['/messages', 'messages'],
      ['/overview', 'overview'], ['/contacts', 'contacts'], ['/active-plan', 'active-plan'],
    ]) {
      const path = `${base}${suffix}?page=2`;
      const before = calls.length;
      assert.equal((await get(port, path)).status, 401);
      assert.equal((await get(port, path, 'member')).status, 403);
      assert.equal(calls.length, before);
      const response = await get(port, path, 'superadmin');
      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      const args = calls.at(-1);
      if (['activities', 'campaigns', 'messages', 'contacts'].includes(resource)) {
        assert.equal(args[0], 'collection');
        assert.equal(args[1], resource);
        assert.equal(args[2].page, '2');
        assert.deepEqual(args.slice(3), [companyId, userId]);
      } else assert.deepEqual(args, [resource, ...(resource === 'details' ? [userId, companyId] : [companyId, userId])]);
      if (resource === 'active-plan') {
        assert.equal(response.body.message, 'No active plan');
        assert.equal(response.body.data.active_plan, null);
      }
    }
    activePlan = { id: 'active' };
    const active = await get(port, `${base}/active-plan`, 'superadmin');
    assert.equal(active.body.message, 'User active plan retrieved');
    assert.equal(active.body.data.active_plan.id, 'active');
    for (const suffix of ['users', 'domains', 'activities', 'messages', 'campaign']) {
      assert.equal((await get(port, `/v1/super-admin/companies/${companyId}/${suffix}`, 'superadmin')).status, 200);
      assert.equal(calls.at(-1)[0], 'company-collection');
    }
    assert.equal((await get(port, `/v1/super-admin/companies/${companyId}/overview`, 'superadmin')).status, 200);
    assert.equal(calls.at(-1)[0], 'company-overview');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
