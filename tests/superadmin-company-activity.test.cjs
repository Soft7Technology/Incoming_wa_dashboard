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
function load(file, deps) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, { exports, Date, require(name) { assert.ok(name in deps, name); return deps[name]; } });
  return exports;
}
const companyId = '87af00e3-cdf0-4c59-9950-143dbadf5ebc';
const otherId = 'ae815512-cf4b-4e7e-8472-16d3c2d4bb18';
const validation = load('src/app/utils/superAdminValidation.ts', {
  uuid: require('uuid'), '@surefy/exceptions/HTTP400Error': HttpError,
});
function operationsService(model, companyModel) {
  return load('src/app/services/superAdminOperations.service.ts', {
    '../models/superAdminOperations.model': model, '../models/superAdmin.model': companyModel,
    '../utils/superAdminValidation': validation,
  }).default;
}

test('company plan reports validate inputs, enforce URL scope and stop for missing companies', async () => {
  for (const resource of ['plans', 'active_plans']) {
    const calls = [];
    const service = operationsService({ list: async (name, filters) => { calls.push({ name, filters }); return {}; } },
      { company: async id => { calls.push(id); } });
    for (const [id, query] of [['bad', {}], [companyId, { limit: '101' }],
      [companyId, { user_id: 'bad' }], [companyId, { domain_status: 'active' }],
      [companyId, { status: 'CANCELLED' }], [companyId, { forwarded: 'true' }],
      [companyId, { sort: 'password' }], [companyId, { from: '2026-10-05', to: '2026-10-01' }]]) {
      await assert.rejects(service.companyList(resource, id, query));
    }
    assert.equal(calls.length, 0);
    await service.companyList(resource, companyId, { company_id: otherId, user_id: otherId, page: '2', limit: '10' });
    assert.equal(calls[0], companyId);
    assert.equal(calls[1].name, resource);
    assert.equal(calls[1].filters.company_id, companyId);
    assert.equal(calls[1].filters.user_id, otherId);
    assert.equal(calls[1].filters.page, 2);
    const missing = operationsService({ list: () => assert.fail('must not list missing company') },
      { company: async () => { throw new HttpError({ message: 'Company not found' }); } });
    await assert.rejects(missing.companyList(resource, companyId, {}), /Company not found/);
  }
});

test('company activity validates inputs and cannot expand company visibility through query filters', async () => {
  let filters;
  const service = load('src/app/services/superAdmin.service.ts', {
    bcrypt: {}, '../models/superAdmin.model': {
      company: async id => assert.equal(id, companyId), collection: async (_, values) => { filters = values; },
    }, '../utils/superAdminValidation': validation,
    '@surefy/exceptions/HTTP400Error': HttpError, '@surefy/exceptions/HTTP403Error': HttpError,
  }).default;
  await assert.rejects(service.collection('activities', {}, 'bad'), /UUID/);
  await assert.rejects(service.collection('activities', { domain_status: 'active' }, companyId), /domain_status/);
  await service.collection('activities', { company_id: otherId, user_id: otherId }, companyId);
  assert.equal(filters.company_id, companyId);
  assert.equal(filters.user_id, otherId);
});

function modelHarness(file) {
  const db = knex({ client: 'pg' }), queries = [];
  let empty = false;
  db.client.runner = builder => ({ run: async () => {
    queries.push(builder.toSQL());
    return builder._method === 'first' ? { total: empty ? '0' : '2' } : empty ? [] : [{ id: 'record' }];
  } });
  class BaseModel { constructor() { this.db = db; } }
  const model = load(file, {
    '@surefy/models/base.model': { BaseModel }, '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError, './subscription.model': {},
  }).default;
  return { db, model, queries, empty: () => { empty = true; } };
}

test('plan count and page queries share company, user, search and date filters; active plans enforce valid periods', async () => {
  const h = modelHarness('src/app/models/superAdminOperations.model.ts');
  try {
    for (const resource of ['plans', 'active_plans']) {
      h.queries.length = 0;
      const result = await h.model.list(resource, {
        company_id: companyId, user_id: otherId, search: 'Monthly%_', page: 2, limit: 10,
        from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
      });
      assert.equal(result.pagination.total, 2);
      assert.equal(h.queries.length, 2);
      for (const q of h.queries) {
        assert.match(q.sql, /"company_id" = \? and "user_id" = \?/);
        assert.ok(q.bindings.includes(companyId) && q.bindings.includes(otherId));
        assert.match(q.sql, /"created_at" >= \? and "created_at" < \?/);
        assert.ok(q.bindings.includes('%Monthly\\%\\_%'));
        if (resource === 'active_plans') {
          assert.match(q.sql, /from "user_plans"/);
          assert.match(q.sql, /"active" = \? and "status" = \? and "start_date" <= \? and "end_date" > \?/);
          assert.ok(q.bindings.includes(true) && q.bindings.includes('COMPLETED'));
          const dates = q.bindings.filter(value => value instanceof Date);
          assert.equal(dates.length, 2);
          assert.equal(dates[0].getTime(), dates[1].getTime());
        } else {
          assert.match(q.sql, /from "subscription_plans"/);
          assert.doesNotMatch(q.sql, /"active" =/);
        }
      }
      const page = h.queries.find(q => q.method === 'select');
      assert.match(page.sql, /order by "created_at" desc, "id" asc limit \? offset \?/);
      assert.deepEqual(page.bindings.slice(-2), [10, 10]);
      if (resource === 'active_plans') assert.match(page.sql, /"limits", "usage"/);
    }
    h.empty();
    const empty = await h.model.list('active_plans', { company_id: companyId, page: 1, limit: 25 });
    assert.equal(empty.items.length, 0);
    assert.equal(empty.pagination.total, 0);
  } finally { await h.db.destroy(); }
});

test('activity count and page queries cover company users and exclude deleted logs', async () => {
  const h = modelHarness('src/app/models/superAdmin.model.ts');
  try {
    const result = await h.model.collection('activities', { company_id: companyId, page: 1, limit: 25 });
    assert.equal(result.pagination.total, 2);
    for (const q of h.queries) {
      assert.match(q.sql, /from "activity_logs" where "deleted_at" is null and "company_id" = \?/);
      assert.ok(q.bindings.includes(companyId));
      assert.doesNotMatch(q.sql, /"user_id" =/);
    }
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

test('requested GET routes use company handlers behind JWT and live superadmin authorization', async () => {
  const calls = [];
  const helpers = {
    tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
    successResponse: (req, res, message, data) => res.json({ success: true, message, data }),
  };
  const controller = load('src/app/http/controllers/superAdmin.controller.ts', {
    '@surefy/utils/Controller': helpers, '@surefy/utils/HttpStatusCode': {},
    '../../services/superAdmin.service': {
      authorize: async id => { if (id !== 'superadmin') throw new HttpError({ message: 'Active superadmin access required' }); },
      collection: async (...args) => { calls.push(args); return { items: [] }; },
    },
  }).default;
  const operations = load('src/app/http/controllers/superAdminOperations.controller.ts', {
    '@surefy/utils/Controller': helpers, '../../services/superAdminOperations.service': {
      companyList: async (...args) => { calls.push(args); return { items: [] }; },
    },
  }).default;
  const route = load('src/routes/superAdmin.route.ts', {
    express, '../app/http/controllers/superAdmin.controller': controller,
    '../app/http/controllers/superAdminOperations.controller': operations,
    '../app/http/controllers/superAdminUserPlan.controller': {
      availableForCompany: (req, res) => res.end(), available: (req, res) => res.end(),
      assign: (req, res) => res.end(), details: (req, res) => res.end(), changeStatus: (req, res) => res.end(),
    },
    '@surefy/middleware/jwtAuth.middleware': { jwtAuthMiddleware(req, res, next) {
      if (!req.headers.authorization) return res.status(401).json({ message: 'JWT required' });
      req.userId = req.headers.authorization;
      next();
    } },
  }).default;
  const app = express();
  app.use('/v1/super-admin', route);
  app.use((error, req, res, next) => res.status(403).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const [suffix, resource] of [['activity', 'activities'], ['subscription-plans', 'plans'], ['active-plans', 'active_plans']]) {
      const path = `/v1/super-admin/companies/${companyId}/${suffix}?page=2`;
      assert.equal((await get(server.address().port, path)).status, 401);
      assert.equal((await get(server.address().port, path, 'member')).status, 403);
      const before = calls.length;
      const response = await get(server.address().port, path, 'superadmin');
      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1)[0], resource);
      const args = calls.at(-1);
      assert.equal(suffix === 'activity' ? args[2] : args[1], companyId);
      assert.equal((suffix === 'activity' ? args[1] : args[2]).page, '2');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
