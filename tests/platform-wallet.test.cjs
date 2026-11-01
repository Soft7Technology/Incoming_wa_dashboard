const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { loadSource } = require('./helpers/background-database.cjs');
const platformId = '5a66df74-92d4-4bcd-814b-13d6318d4116';
const adminId = '3edb9651-a061-4280-866d-bc472e7a02f6';
const companyId = 'ae815512-cf4b-4e7e-8472-16d3c2d4bb18';
class HttpError extends Error { constructor({ message }) { super(message); this.statusCode = 400; } }
const errors = Object.fromEntries(['HTTP400Error', 'HTTP401Error', 'HTTP404Error'].map(name => [`@surefy/exceptions/${name}`, HttpError]));
const validation = loadSource('src/app/utils/superAdminValidation.ts', errors);
const ledger = loadSource('src/app/utils/creditLedger.ts');

function service(model, db = () => { throw Error('Unexpected database access'); }) {
  return loadSource('src/app/services/credit.service.ts', { ...errors,
    '@surefy/database': db, '@surefy/console/models/creditTransaction.model': model,
    '../utils/superAdminValidation': validation, '../utils/creditLedger': ledger,
  }).default;
}

test('platform history validates filters and cannot accept a caller-selected wallet or company', async () => {
  const calls = [];
  const credit = service({ getPlatformTransactions: async (...args) => {
    calls.push(args); return { data: [], pagination: { total: 0 } };
  } });
  for (const filters of [
    { user_id: adminId }, { company_id: companyId }, { wallet_user_id: adminId },
    { page: '0' }, { limit: '101' }, { type: ['credit'] }, { type: 'unknown' },
    { reference_type: 'manual' }, { reference_type: ['plan_addon'] },
    { from: 'invalid' }, { from: '2026-10-28', to: '2026-10-01' },
  ]) await assert.rejects(credit.getPlatformTransactions(platformId, filters));
  await assert.rejects(credit.getPlatformTransactions('invalid', {}));
  assert.equal(calls.length, 0);
  const result = await credit.getPlatformTransactions(platformId, {
    page: '2', limit: '5', reference_type: 'plan_addon', from: '2026-10-01', to: '2026-11-01',
  });
  assert.equal(result.wallet_scope, 'platform');
  assert.equal(result.wallet_user_id, platformId);
  assert.equal(calls[0][0], platformId);
  assert.equal(calls[0][1].page, 2);
  assert.equal(calls[0][1].limit, 5);
  assert.equal(calls[0][1].from, '2026-10-01T00:00:00.000Z');
});

test('platform balance reads the user wallet without using or changing its company link', async () => {
  const user = { id: platformId, company_id: companyId, credit_balance: '147294' };
  const before = JSON.stringify(user), scopes = [];
  const db = table => {
    assert.equal(table, 'users');
    return {
      where(scope) { scopes.push(scope); return this; },
      whereNull(column) { assert.equal(column, 'deleted_at'); return this; },
      async first() { return user; },
    };
  };
  const credit = service({
    getPlatformFeeTotal: async id => { assert.equal(id, platformId); return 63960; },
    getLatestPlatformTransaction: async id => { assert.equal(id, platformId); return null; },
  }, db);
  const result = await credit.getPlatformBalance(platformId);
  assert.equal(result.wallet_scope, 'platform');
  assert.equal(result.wallet_user_id, platformId);
  assert.equal(result.balance, '147294');
  assert.equal(result.platform_fee_total, 63960);
  assert.equal(Object.hasOwn(result, 'company_id'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(scopes)), [{ id: platformId, role: 'superadmin' }]);
  assert.equal(JSON.stringify(user), before);
  // Legacy response stays compatible, while the wallet read is independent of company ID.
  assert.equal((await credit.getBalance('legacy-company', platformId)).balance, '147294');
});

test('SQL separates platform and company wallets in both counts and pages, without writes', async () => {
  const queries = [];
  const db = require('knex')({ client: 'pg' });
  db.client.runner = builder => ({ run: async () => {
    const sql = builder.toSQL(); queries.push(sql);
    assert.match(sql.sql, /^select /);
    return builder._method === 'first' ? { total: '0' } : [];
  } });
  class BaseModel { constructor(table) { this.db = db; this.tableName = table; } query() { return db(this.tableName); } }
  const model = loadSource('src/app/models/creditTransaction.model.ts', {
    '@surefy/models/base.model': { BaseModel }, '../utils/creditLedger': ledger,
  }).default;
  try {
    await model.getCompanyTransaction('irrelevant-company', { page: 2, limit: 5,
      reference_type: 'plan_addon', from: '2026-10-01', to: '2026-11-01' }, platformId);
    assert.equal(queries.length, 2);
    for (const query of queries) {
      assert.match(query.sql, /exists \(select 1 from "users" as "wallet_owner"/);
      assert.ok(query.bindings.includes(platformId));
      assert.ok(query.bindings.includes('superadmin'));
      assert.ok(query.bindings.includes('plan_addon'));
      assert.ok(query.bindings.includes('2026-10-01'));
      assert.ok(query.bindings.includes('2026-11-01'));
      assert.ok(!query.bindings.includes('irrelevant-company'));
      assert.doesNotMatch(query.sql, /"company_id" =/);
    }
    assert.match(queries[1].sql, /order by "created_at" desc, "id" desc/);
    queries.length = 0;
    await model.getCompanyTransaction(companyId, { limit: 5 });
    assert.equal(queries.length, 2);
    for (const query of queries) {
      assert.match(query.sql, /not exists \(select 1 from "users" as "wallet_owner"/);
      assert.ok(query.bindings.includes(companyId));
      assert.ok(query.bindings.includes('superadmin'));
    }
  } finally { await db.destroy(); }
});

function get(port, path, token) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers: token ? { authorization: token } : {} }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('mounted superadmin wallet routes require live authorization and use authenticated identity', async () => {
  const calls = [], helpers = {
    tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
    successResponse: (_req, res, message, data) => res.json({ success: true, message, data }),
  };
  const credit = service({ getPlatformTransactions: async (id, filters) => {
    calls.push({ id, filters }); return { data: [{ user_id: id }], pagination: { total: 1 } };
  } });
  const wallet = loadSource('src/app/http/controllers/platformWallet.controller.ts', {
    '@surefy/utils/Controller': helpers, '../../services/credit.service': {
      getPlatformTransactions: (...args) => credit.getPlatformTransactions(...args),
      getPlatformBalance: async id => { calls.push({ id }); return { wallet_scope: 'platform', wallet_user_id: id }; },
    },
  }).default;
  const controller = loadSource('src/app/http/controllers/superAdmin.controller.ts', {
    '@surefy/utils/Controller': helpers, '../../services/superAdmin.service': {
      authorize: async id => { if (id !== platformId) {
        const error = Error('Active superadmin access required'); error.statusCode = 403; throw error;
      } },
    },
  }).default;
  const operations = loadSource('src/app/http/controllers/superAdminOperations.controller.ts', {
    '@surefy/utils/Controller': helpers,
  }).default;
  const noop = (_req, res) => res.json({});
  const authenticate = (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ message: 'JWT required' });
    req.userId = req.headers.authorization === 'superadmin' ? platformId : adminId;
    req.userRole = req.userId === platformId ? 'superadmin' : 'admin';
    req.companyId = companyId; next();
  };
  const router = loadSource('src/routes/superAdmin.route.ts', {
    express, '@surefy/middleware/jwtAuth.middleware': { jwtAuthMiddleware: authenticate },
    '../app/http/controllers/platformWallet.controller': wallet,
    '../app/http/controllers/superAdmin.controller': controller,
    '../app/http/controllers/superAdminOperations.controller': operations,
    '../app/http/controllers/platformPricing.controller': { get: noop, update: noop, allAddons: noop, updateAddon: noop },
    '../app/http/controllers/planCatalog.controller': { features: noop, createFeature: noop, createAddon: noop, disableAddon: noop },
    '../app/http/controllers/superAdminUserPlan.controller': {
      availableForCompany: noop, available: noop, assign: noop, details: noop, changeStatus: noop,
    },
  }).default;
  const app = express(); app.use('/v1/super-admin', router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    for (const route of ['/wallet', '/wallet/transactions']) {
      assert.equal((await get(port, '/v1/super-admin' + route)).status, 401);
      assert.equal((await get(port, '/v1/super-admin' + route, 'admin')).status, 403);
      const response = await get(port, '/v1/super-admin' + route, 'superadmin');
      assert.equal(response.status, 200);
      assert.equal(response.body.data.wallet_user_id, platformId);
    }
    const before = calls.length;
    for (const query of ['user_id=' + adminId, 'company_id=' + companyId, 'limit=101'])
      assert.equal((await get(port, '/v1/super-admin/wallet/transactions?' + query, 'superadmin')).status, 400);
    assert.equal(calls.length, before);
    assert.ok(calls.every(call => call.id === platformId));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
