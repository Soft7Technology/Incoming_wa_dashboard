const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { loadSource } = require('./helpers/background-database.cjs');
class HttpError extends Error { constructor({ message, details }) { super(message); this.details = details; } }
class BadRequest extends HttpError { statusCode = 400; }
class Forbidden extends HttpError { statusCode = 403; }
class NotFound extends HttpError { statusCode = 404; }
class CustomError extends Error { constructor(message, statusCode, _operational, details) { super(message); this.statusCode = statusCode; this.details = details; } }
const clock = Date.parse('2026-10-20T12:00:00.000Z');
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
const userId = '00000000-0000-4000-8000-000000000001';
const planId = '00000000-0000-4000-8000-000000000002';
const companyId = '00000000-0000-4000-8000-000000000003';
const actor = { userId: '00000000-0000-4000-8000-000000000004', companyId, userRole: 'admin' };
const request = { days: 30, expected_end_date: '2026-10-23T12:00:00.000Z', reason: 'Customer support extension' };
const errors = { '@surefy/exceptions/HTTP400Error': BadRequest, '@surefy/exceptions/HTTP403Error': Forbidden,
  '@surefy/exceptions/HTTP404Error': NotFound, '@surefy/exceptions/CustomError': { CustomError },
  '@surefy/utils/HttpStatusCode': { HttpStatusCode: { CONFLICT: 409 } } };

test('PostgreSQL extension-policy migration preserves dates and counts only recorded manual extensions',
  { skip: process.env.PLAN_EXTENSION_DATABASE_TEST !== 'true' }, async () => {
    require('dotenv').config({ quiet: true }); require('ts-node/register');
    const crypto = require('node:crypto');
    const config = require('../library/surefy/src/config/knex.config').default.development;
    const db = require('knex')({ ...config, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });
    const migration = require('../src/database/migrations/20261020000002_subscription_extension_policy');
    const schema = 'extension_policy_test_' + crypto.randomUUID().replaceAll('-', '');
    const marker = Error('ROLLBACK_EXTENSION_POLICY_MIGRATION');
    try {
      await assert.rejects(db.transaction(async trx => {
        await trx.schema.createSchema(schema); await trx.raw('SET LOCAL search_path TO ??', [schema]);
        await trx.schema.createTable('user_plans', t => { t.uuid('id').primary(); t.uuid('user_id'); t.timestamp('end_date', { useTz: true }); });
        await trx.schema.createTable('activity_logs', t => {
          t.uuid('entity_id'); t.string('entity_type'); t.string('action'); t.string('status'); t.jsonb('new_data');
        });
        const untouched = crypto.randomUUID();
        await trx('user_plans').insert([{ id: planId, user_id: userId, end_date: request.expected_end_date },
          { id: untouched, user_id: userId, end_date: request.expected_end_date }]);
        const record = days => ({ entity_id: planId, entity_type: 'SUBSCRIPTION', action: 'UPDATE', status: 'SUCCESS',
          new_data: JSON.stringify({ id: planId, user_id: userId, days_added: days, previous_end_date: '2026-10-01T00:00:00Z', extension_starts_at: '2026-10-01T00:00:00Z' }) });
        await trx('activity_logs').insert([record(5), record(7), record('invalid'), { ...record(30), action: 'ACTIVATE' }]);
        await migration.up(trx);
        const row = await trx('user_plans').where({ id: planId }).first();
        assert.equal(row.extension_days, 12); assert.equal(row.extension_platform_fee_paise, null);
        assert.equal(row.end_date.toISOString(), request.expected_end_date);
        assert.equal((await trx('user_plans').where({ id: untouched }).first()).extension_days, 0);
        await migration.down(trx);
        assert.equal((await trx('user_plans').where({ id: planId }).first()).extension_days, undefined);
        throw marker;
      }), error => error === marker);
    } finally { await db.destroy(); }
  });
function service(db, DateType = FixedDate) {
  const pricing = loadSource('src/app/services/platformPricing.service.ts', { ...errors, '@surefy/database': db, './planCatalog.service': {} }).default;
  return loadSource('src/app/services/planExtension.service.ts', { ...errors, '@surefy/database': db,
    './platformPricing.service': pricing,
    '../utils/activityContext': { markActivityRecorded() {} } }, { Date: DateType }).default;
}
function fixture() {
  let state = { users: [{ id: userId, company_id: companyId, role: 'user', status: 'suspended', assigned_plan: planId },
    { id: '00000000-0000-4000-8000-000000000005', company_id: '00000000-0000-4000-8000-000000000006', role: 'superadmin', credit_balance: '20.00' }],
    user_plans: [{ id: planId, user_id: userId, company_id: companyId, active: true, status: 'COMPLETED',
      start_date: '2026-09-23T12:00:00.000Z', end_date: request.expected_end_date, duration_days: 30,
      plan_name: 'Pro', billing_cycle: 'Monthly', price: 200, limits: { Contact: { limit: 20000 }, TeamInvite: { limit: 2 } },
      usage: { Campaign: 5 }, usage_periods: { Campaign: '2026-09-23T12:00:00.000Z' }, addons: [], extension_days: 0, extension_platform_fee_paise: null }],
    user_plan_addons: [{ user_plan_id: planId, user_id: userId, company_id: companyId, expires_at: request.expected_end_date,
      amount_paise: 2000, units: 1 }], activity_logs: [], companies: [{ id: companyId, credit_balance: '500.00' }], credit_transactions: [],
    platform_fee_settings: [{ id: 'default', monthly_fee_paise: 10000, yearly_fee_paise: 100000 }] };
  let tail = Promise.resolve(), failTable;
  const locks = [];
  const connection = draft => table => {
    const filters = []; let operation, payload, first = false;
    const q = {
      where(values) { filters.push(row => Object.entries(values).every(([k, v]) => row[k] === v)); return q; },
      whereNot(values) { filters.push(row => !Object.entries(values).every(([k, v]) => row[k] === v)); return q; },
      whereNull(key) { filters.push(row => row[key] == null); return q; },
      whereIn(key, values) { filters.push(row => values.includes(row[key])); return q; }, orderBy() { return q; },
      forUpdate() { locks.push(table); return q; }, first() { first = true; return q; },
      update(value) { operation = 'update'; payload = value; return q; },
      insert(value) { operation = 'insert'; payload = value; return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (operation && table === failTable) throw Error('audit failed');
        let rows = draft[table].filter(row => filters.every(match => match(row)));
        if (operation === 'update') rows.forEach(row => Object.assign(row, structuredClone(payload)));
        if (operation === 'insert') { rows = (Array.isArray(payload) ? payload : [payload]).map(row => structuredClone(row)); draft[table].push(...rows); }
        return first ? rows[0] : rows;
      }).then(resolve, reject); },
    }; return q;
  };
  const db = { transaction(callback) {
    const result = tail.then(async () => { const draft = structuredClone(state); const result = await callback(connection(draft)); state = draft; return result; });
    tail = result.catch(() => {}); return result;
  } };
  return { api: service(db), state: () => state, locks, failAudit: () => { failTable = 'activity_logs'; }, fail: table => { failTable = table; } };
}

test('ten free days extend the assigned expiry and purchased packs without resetting limits, usage or billing', async () => {
  const f = fixture(), before = structuredClone(f.state());
  const result = await f.api.extend(actor, planId, { ...request, days: 10 });
  assert.equal(result.end_date, '2026-11-02T12:00:00.000Z');
  assert.equal(result.duration_days, 40); assert.equal(result.id, planId);
  assert.equal(result.extension_fee_paise, 0); assert.equal(result.extension_days_used, 10);
  const after = f.state().user_plans[0];
  assert.equal(Object.hasOwn(after, 'updated_at'), false); // user_plans has no updated_at column.
  for (const key of ['limits', 'usage', 'usage_periods', 'addons', 'price', 'billing_cycle', 'start_date', 'active', 'status'])
    assert.deepEqual(after[key], before.user_plans[0][key]);
  assert.equal(new Date(f.state().user_plan_addons[0].expires_at).toISOString(), result.end_date);
  assert.equal(f.state().user_plan_addons[0].amount_paise, 2000);
  assert.deepEqual(f.state().users, before.users); // Account suspension is never lifted.
  assert.deepEqual(f.state().companies, before.companies); assert.deepEqual(f.state().credit_transactions, []);
  assert.deepEqual(f.locks, ['users', 'user_plans']);
  assert.equal(f.state().activity_logs[0].user_id, actor.userId);
  assert.equal(JSON.parse(f.state().activity_logs[0].new_data).reason, request.reason);
});

test('expired current completed plans extend from now; Free trials can receive a manual time extension', async () => {
  const f = fixture(); Object.assign(f.state().user_plans[0], { end_date: '2026-10-01T12:00:00.000Z', billing_cycle: 'Free', plan_name: 'Free' });
  const result = await f.api.extend(actor, planId, { days: 7, expected_end_date: '2026-10-01T12:00:00.000Z' });
  assert.equal(result.end_date, '2026-10-27T12:00:00.000Z');
  assert.equal(result.extension_starts_at, '2026-10-20T12:00:00.000Z');
  assert.equal(result.duration_days, 34);
});

test('duplicate, concurrent and stale requests cannot apply the same extension twice', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.api.extend(actor, planId, request), f.api.extend(actor, planId, request)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const error = results.find(row => row.status === 'rejected').reason;
  assert.equal(error.statusCode, 409); assert.equal(error.details.code, 'PLAN_EXTENSION_CONFLICT');
  assert.equal(f.state().activity_logs.length, 1);
  await assert.rejects(f.api.extend(actor, planId, request), error => error.statusCode === 409);
  await assert.rejects(f.api.extend(actor, planId, { ...request, expected_end_date: '2026-11-22T12:00:00.000Z' }),
    error => error.statusCode === 409 && error.details.code === 'PLAN_EXTENSION_CAP_REACHED');
  assert.equal(f.state().credit_transactions.length, 2);
  assert.equal(f.state().companies[0].credit_balance, 400);
});

test('tenant isolation and roles are enforced using authenticated actor fields', async () => {
  const f = fixture();
  await assert.rejects(f.api.extend({ ...actor, companyId: 'other' }, planId, request), error => error.statusCode === 404);
  for (const userRole of ['user', 'member', undefined])
    await assert.rejects(f.api.extend({ ...actor, userRole }, planId, request), error => error.statusCode === 403);
  await assert.rejects(f.api.extend({ ...actor, companyId: undefined }, planId, request), error => error.statusCode === 403);
  const result = await f.api.extend({ ...actor, userRole: 'superadmin', companyId: undefined }, planId, request);
  assert.equal(result.end_date, '2026-11-22T12:00:00.000Z');
});

test('invalid payloads cannot set dates, capacity, prices or identity directly', async () => {
  const f = fixture(), before = structuredClone(f.state());
  for (const input of [null, [], {}, { days: 1 }, { ...request, days: '30' }, { ...request, days: 0 },
    { ...request, days: -1 }, { ...request, days: 1.5 }, { ...request, days: 4 }, { ...request, days: 31 },
    { ...request, expected_end_date: '23/10/2026' }, { ...request, expected_end_date: 'invalid' },
    { ...request, reason: '' }, { ...request, reason: 'x'.repeat(501) },
    ...['company_id', 'user_id', 'end_date', 'features', 'price', 'extension_days', 'extension_platform_fee_paise'].map(key => ({ ...request, [key]: 1 }))]) {
    await assert.rejects(f.api.extend(actor, planId, input), error => error.statusCode === 400);
  }
  await assert.rejects(f.api.extend(actor, 'invalid-id', request), error => error.statusCode === 400);
  assert.deepEqual(f.state(), before);
});

test('pending, cancelled, suspended, replaced, future and inconsistent assignments cannot be extended', async () => {
  for (const changes of [{ status: 'PENDING' }, { status: 'CANCELLED' }, { active: false }, { status: 'EXPIRED', active: false },
    { start_date: '2026-10-22T00:00:00.000Z' }, { end_date: 'invalid' }]) {
    const f = fixture(); Object.assign(f.state().user_plans[0], changes);
    await assert.rejects(f.api.extend(actor, planId, request), error => error.statusCode === 409);
    assert.equal(f.state().activity_logs.length, 0);
  }
  for (const mutate of [f => { f.state().users[0].assigned_plan = 'replacement'; },
    f => { f.state().user_plans.push({ ...f.state().user_plans[0], id: 'another' }); }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.api.extend(actor, planId, request), error => error.statusCode === 409);
  }
});

test('audit failures roll back plan and purchased-pack expiry updates', async () => {
  const f = fixture(), before = structuredClone(f.state()); f.failAudit();
  await assert.rejects(f.api.extend(actor, planId, request), /audit failed/);
  assert.deepEqual(f.state(), before);
});

test('five and ten days are free; eleven and thirty days charge the monthly platform fee once', async () => {
  for (const days of [5, 10, 11, 30]) {
    const f = fixture();
    const result = await f.api.extend(actor, planId, { ...request, days });
    const fee = days > 10 ? 10000 : 0;
    assert.equal(result.extension_fee_paise, fee);
    assert.equal(result.extension_days_remaining, 30 - days);
    assert.equal(f.state().user_plans[0].extension_days, days);
    assert.equal(f.state().user_plans[0].extension_platform_fee_paise, days > 10 ? 10000 : null);
    assert.equal(f.state().credit_transactions.length, fee > 0 ? 2 : 0);
    if (fee > 0) {
      const [debit, credit] = f.state().credit_transactions;
      assert.equal(debit.reference_type, 'subscription_extension'); assert.equal(debit.reference_id, planId);
      assert.equal(debit.company_id, companyId); assert.equal(debit.amount, -100); assert.equal(credit.amount, 100);
      assert.equal(debit.balance_after - debit.balance_before, debit.amount);
      assert.equal(credit.balance_after - credit.balance_before, credit.amount);
      assert.equal(f.state().companies[0].credit_balance, 400);
      assert.equal(f.state().users[1].credit_balance, 120);
    }
  }
});

test('splitting requests does not bypass the cumulative free allowance or the 30-day cap', async () => {
  const f = fixture(); let expected = request.expected_end_date;
  for (const [days, fee] of [[5, 0], [5, 0], [5, 10000], [10, 0], [5, 0]]) {
    const result = await f.api.extend(actor, planId, { ...request, days, expected_end_date: expected });
    assert.equal(result.extension_fee_paise, fee); expected = result.end_date;
  }
  assert.equal(f.state().user_plans[0].extension_days, 30);
  assert.equal(f.state().credit_transactions.length, 2);
  const before = structuredClone(f.state());
  await assert.rejects(f.api.extend(actor, planId, { ...request, days: 5, expected_end_date: expected }),
    error => error.details.code === 'PLAN_EXTENSION_CAP_REACHED' && error.details.extension_days_remaining === 0);
  assert.deepEqual(f.state(), before);
  const policy = await f.api.policy(actor, planId);
  assert.equal(policy.can_extend, false); assert.equal(policy.extension_fee_applied, true);
  assert.equal(policy.extension_days_remaining, 0);
});

test('live superadmin monthly pricing is used, including a zero-fee waiver, without using yearly pricing', async () => {
  const f = fixture(); f.state().platform_fee_settings[0].monthly_fee_paise = 12525;
  f.state().user_plans[0].billing_cycle = 'Yearly';
  assert.equal((await f.api.policy(actor, planId)).monthly_platform_fee_paise, 12525);
  assert.equal((await f.api.extend(actor, planId, { ...request, days: 11 })).extension_fee_paise, 12525);
  assert.equal(f.state().companies[0].credit_balance, 374.75);
  const waived = fixture(); waived.state().platform_fee_settings[0].monthly_fee_paise = 0;
  waived.state().users = waived.state().users.slice(0, 1);
  const first = await waived.api.extend(actor, planId, { ...request, days: 15 });
  assert.equal(first.extension_platform_fee_paise, 0);
  waived.state().platform_fee_settings[0].monthly_fee_paise = 99999;
  const second = await waived.api.extend(actor, planId, { ...request, days: 5, expected_end_date: first.end_date });
  assert.equal(second.extension_fee_paise, 0); assert.equal(waived.state().credit_transactions.length, 0);
});

test('insufficient or invalid wallets, missing platform recipient and failed writes leave dates and fees unchanged', async () => {
  for (const mutate of [f => { f.state().companies[0].credit_balance = '99.99'; },
    f => { f.state().companies[0].credit_balance = '-1'; }, f => { f.state().users.pop(); },
    f => f.fail('credit_transactions'), f => f.fail('user_plan_addons'), f => f.fail('user_plans')]) {
    const f = fixture(); mutate(f); const before = structuredClone(f.state());
    await assert.rejects(f.api.extend(actor, planId, request));
    assert.deepEqual(f.state(), before);
  }
  const exact = fixture(); exact.state().companies[0].credit_balance = '100.00';
  await exact.api.extend(actor, planId, request); assert.equal(exact.state().companies[0].credit_balance, 0);
});

test('policy preview is scoped, reports the remaining allowance, and never charges wallets', async () => {
  const f = fixture(), before = structuredClone(f.state());
  const policy = await f.api.policy(actor, planId);
  assert.equal(policy.min_days, 5); assert.equal(policy.max_days, 30); assert.equal(policy.free_days, 10);
  assert.equal(policy.expected_end_date, request.expected_end_date); assert.equal(policy.monthly_platform_fee_paise, 10000);
  assert.equal(policy.can_extend, true); assert.equal(policy.extension_fee_applied, false);
  await assert.rejects(f.api.policy({ ...actor, companyId: 'foreign' }, planId), error => error.statusCode === 404);
  assert.deepEqual(f.state(), before);
});

test('mounted API forwards only authenticated actor data and returns the updated user plan', async () => {
  const f = fixture();
  const controller = loadSource('src/app/http/controllers/planExtension.controller.ts', {
    '../../services/planExtension.service': f.api,
    '@surefy/utils/Controller': { tryCatchAsync: callback => (req, res, next) => Promise.resolve(callback(req, res)).catch(next),
      successResponse: (_req, res, message, data) => res.json({ success: true, message, data }) },
  }).default;
  const other = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : (_req, res) => res.sendStatus(501) });
  const router = loadSource('src/routes/subscription.route.ts', { express,
    '@surefy/console/http/controllers/subscription.controller': other,
    '../app/http/controllers/planCatalog.controller': other, '../app/http/controllers/platformPricing.controller': other,
    '../app/http/controllers/planExtension.controller': controller,
  }).default;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, actor); next(); });
  app.use('/v1/admin/subscription', router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message, error: error.details }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/admin/subscription/user-plans/${planId}/extend`;
    const policy = await fetch(url.replace('/extend', '/extension-policy'));
    assert.equal(policy.status, 200); assert.equal(policy.headers.get('cache-control'), 'no-store');
    assert.equal((await policy.json()).data.monthly_platform_fee_paise, 10000);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(response.status, 200); assert.equal((await response.json()).data.end_date, '2026-11-22T12:00:00.000Z');
    const duplicate = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(duplicate.status, 409);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('PostgreSQL extension persists dates, duration and audit atomically without modifying quota JSONB',
  { skip: process.env.PLAN_EXTENSION_DATABASE_TEST !== 'true' }, async () => {
    require('dotenv').config({ quiet: true }); require('ts-node/register');
    const crypto = require('node:crypto');
    const config = require('../library/surefy/src/config/knex.config').default.development;
    const db = require('knex')({ ...config, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });
    const schema = 'extension_test_' + crypto.randomUUID().replaceAll('-', '');
    const marker = Error('ROLLBACK_EXTENSION_TEST');
    try {
      await assert.rejects(db.transaction(async trx => {
        await trx.schema.createSchema(schema); await trx.raw('SET LOCAL search_path TO ??', [schema]);
        await trx.schema.createTable('users', t => {
          t.uuid('id').primary(); t.uuid('company_id'); t.uuid('assigned_plan'); t.string('role'); t.timestamp('deleted_at');
          t.string('credit_balance');
        });
        await trx.schema.createTable('user_plans', t => {
          t.uuid('id').primary(); t.uuid('company_id'); t.uuid('user_id'); t.string('plan_name'); t.string('billing_cycle');
          t.string('status'); t.boolean('active'); t.integer('duration_days');
          t.timestamp('start_date', { useTz: true }); t.timestamp('end_date', { useTz: true });
          for (const name of ['limits', 'usage', 'usage_periods', 'addons']) t.jsonb(name);
        });
        await trx.schema.createTable('user_plan_addons', t => {
          t.uuid('user_plan_id'); t.uuid('user_id'); t.uuid('company_id'); t.timestamp('expires_at', { useTz: true }); t.integer('amount_paise');
        });
        await trx.schema.createTable('activity_logs', t => {
          for (const name of ['user_id', 'company_id', 'entity_id']) t.uuid(name);
          for (const name of ['action', 'entity_type', 'status', 'description']) t.string(name);
          t.boolean('read'); t.jsonb('old_data'); t.jsonb('new_data');
        });
        await trx.schema.createTable('companies', t => { t.uuid('id').primary(); t.string('credit_balance'); });
        await trx.schema.createTable('platform_fee_settings', t => {
          t.string('id').primary(); t.integer('monthly_fee_paise'); t.integer('yearly_fee_paise');
        });
        await trx('platform_fee_settings').insert({ id: 'default', monthly_fee_paise: 10000, yearly_fee_paise: 100000 });
        await trx.schema.createTable('credit_transactions', t => {
          for (const name of ['company_id', 'user_id', 'reference_id']) t.uuid(name);
          for (const name of ['type', 'created_by', 'reference_type', 'description']) t.string(name);
          for (const name of ['amount', 'balance_before', 'balance_after']) t.decimal(name, 20, 2);
          t.jsonb('meta_data');
        });
        await require('../src/database/migrations/20261020000002_subscription_extension_policy').up(trx);
        const limits = { Contact: { limit: 20000, addon_limit: 3000 } }, usage = { Campaign: 5 };
        await trx('users').insert({ id: userId, company_id: companyId, assigned_plan: planId, role: 'user' });
        const recipientId = crypto.randomUUID();
        await trx('users').insert({ id: recipientId, company_id: crypto.randomUUID(), role: 'superadmin', credit_balance: '20.00' });
        await trx('companies').insert({ id: companyId, credit_balance: '500.00' });
        await trx('user_plans').insert({ id: planId, user_id: userId, company_id: companyId, plan_name: 'Pro', billing_cycle: 'Monthly',
          status: 'COMPLETED', active: true, duration_days: 30, start_date: '2026-09-23T12:00:00Z', end_date: request.expected_end_date,
          limits: JSON.stringify(limits), usage: JSON.stringify(usage), usage_periods: '{}', addons: '[]' });
        await trx('user_plan_addons').insert({ user_plan_id: planId, user_id: userId, company_id: companyId,
          expires_at: request.expected_end_date, amount_paise: 2000 });
        const api = service({ transaction: callback => trx.transaction(callback) });
        const result = await api.extend(actor, planId, request);
        const row = await trx('user_plans').where({ id: planId }).first();
        assert.equal(row.end_date.toISOString(), result.end_date); assert.equal(row.duration_days, 60);
        assert.equal(row.extension_days, 30); assert.equal(row.extension_platform_fee_paise, 10000);
        assert.equal(Number((await trx('companies').where({ id: companyId }).first()).credit_balance), 400);
        assert.equal(Number((await trx('users').where({ id: recipientId }).first()).credit_balance), 120);
        assert.deepEqual(row.limits, limits); assert.deepEqual(row.usage, usage);
        assert.equal((await trx('user_plan_addons').first()).expires_at.toISOString(), result.end_date);
        assert.equal((await trx('activity_logs').first()).new_data.days_added, 30);
        await assert.rejects(api.extend(actor, planId, request), error => error.statusCode === 409);
        assert.equal(Number((await trx('activity_logs').count('* as total').first()).total), 1);
        assert.equal(Number((await trx('credit_transactions').count('* as total').first()).total), 2);
        await assert.rejects(api.extend(actor, planId, { ...request, days: 5, expected_end_date: result.end_date }),
          error => error.details.code === 'PLAN_EXTENSION_CAP_REACHED');
        await assert.rejects(require('../src/database/migrations/20261020000002_subscription_extension_policy').down(trx), /Reconcile extensions/);
        throw marker;
      }), error => error === marker);
      assert.equal((await db.raw('SELECT 1 FROM pg_namespace WHERE nspname = ?', [schema])).rows.length, 0);
    } finally { await db.destroy(); }
  });
