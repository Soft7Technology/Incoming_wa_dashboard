const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const { loadSource } = require('./helpers/background-database.cjs');
class HttpError extends Error { constructor({ message, details }) { super(message); this.details = details; this.statusCode = 400; } }
class Forbidden extends HttpError { statusCode = 403; }
class NotFound extends HttpError { statusCode = 404; }
class CustomError extends Error { constructor(message, statusCode, _operational, details) { super(message); this.statusCode = statusCode; this.details = details; } }
const errors = { '@surefy/exceptions/HTTP400Error': HttpError, '@surefy/exceptions/HTTP403Error': Forbidden,
  '@surefy/exceptions/HTTP404Error': NotFound, '@surefy/exceptions/CustomError': { CustomError } };
const validation = loadSource('src/app/utils/superAdminValidation.ts', errors);
const webhookSecret = 'test-only-webhook-secret';
const actor = { companyId: crypto.randomUUID(), userId: crypto.randomUUID(), userRole: 'admin', idempotencyKey: 'purchase-1' };
const sign = raw => crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
function service(db, provider) {
  return loadSource('src/app/services/creditTopup.service.ts', { ...errors, '@surefy/database': db,
    '../utils/superAdminValidation': validation, './creditTopup.provider': provider,
    '../utils/activityContext': { markActivityRecorded() {} } }, { process: { env: { RAZORPAY_WEBHOOK_SECRET: webhookSecret } } }).default;
}

test('credit purchase input rejects foreign identity, untrusted payment state, invalid amounts and roles before writes', async () => {
  const api = service(() => assert.fail('Unexpected database call'), { liveCreditConfiguration: () => ({ keyId: 'rzp_live_test' }) });
  for (const amount_paise of [0, -1, 99, 1.25, '100', NaN, Infinity, 100000001])
    await assert.rejects(api.create(actor, { amount_paise }));
  for (const extra of [{ company_id: crypto.randomUUID() }, { user_id: crypto.randomUUID() }, { status: 'paid' }, { payment_id: 'pay_claim' }, { is_test: true }])
    await assert.rejects(api.create(actor, { amount_paise: 100, ...extra }));
  for (const userRole of ['user', 'superadmin', undefined]) await assert.rejects(api.create({ ...actor, userRole }, { amount_paise: 100 }));
  await assert.rejects(api.create({ ...actor, idempotencyKey: undefined }, { amount_paise: 100 }));
  await assert.rejects(api.verify(actor, crypto.randomUUID(), { amount_paise: 100, paid: true }));
  for (const query of [{ company_id: 'foreign' }, { limit: '101' }, { page: '0' }]) await assert.rejects(api.list(actor, query));
});

test('webhook rejects forged and parsed bodies before any database or gateway call', async () => {
  const api = service(() => assert.fail('Unexpected database call'), {});
  const raw = Buffer.from('{ "event": "unrelated.event" }');
  for (const [body, signature] of [[undefined, sign(raw)], [{ event: 'unrelated.event' }, sign(raw)],
    [raw, '0'.repeat(64)], [raw, 'invalid'], [Buffer.from('{}'), sign(raw)]])
    await assert.rejects(api.webhook(body, signature, 'event-1'), /signature/);
  assert.equal((await api.webhook(raw, sign(raw), 'event-1')).ignored, true);
});

test('provider creates single-use fixed-amount QR with server ownership notes and refuses test keys', async () => {
  const calls = [];
  const provider = loadSource('src/app/services/creditTopup.provider.ts', { ...errors,
    axios: { request: async config => { calls.push(config); return { data: { id: 'qr_created' } }; } },
  }, { process: { env: { RAZORPAY_KEY_ID: 'rzp_live_example', RAZORPAY_KEY_SECRET: 'test-secret' } } });
  const order = { id: crypto.randomUUID(), company_id: actor.companyId, user_id: actor.userId,
    amount_paise: 15025, expires_at: new Date(Date.now() + 900000) };
  await provider.createCreditQr(order);
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].data.payment_amount, 15025);
  assert.equal(calls[0].data.usage, 'single_use'); assert.equal(calls[0].data.fixed_amount, true);
  assert.equal(calls[0].data.notes.company_id, actor.companyId);
  assert.equal(calls[0].data.notes.credit_topup_id, order.id);
  assert.equal(calls[0].maxRedirects, 0);
  const test = loadSource('src/app/services/creditTopup.provider.ts', errors,
    { process: { env: { RAZORPAY_KEY_ID: 'rzp_test_example', RAZORPAY_KEY_SECRET: 'test-secret' } } });
  assert.throws(() => test.liveCreditConfiguration(), /live Razorpay/);
  const unavailable = loadSource('src/app/services/creditTopup.provider.ts', { ...errors,
    axios: { request: async () => { throw Error('secret-from-axios'); } },
  }, { process: { env: { RAZORPAY_KEY_ID: 'rzp_live_example', RAZORPAY_KEY_SECRET: 'test-secret' } } });
  await assert.rejects(unavailable.fetchCreditPayment('pay_example'), error => error.statusCode === 503 && !error.message.includes('secret-from-axios'));
});

test('PostgreSQL topups verify capture, credit once, isolate tenants, reconcile refunds and roll back failures',
  { skip: process.env.CREDIT_TOPUP_DATABASE_TEST !== 'true' }, async () => {
    require('dotenv').config({ quiet: true });
    const db = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });
    const schema = 'credit_topup_test_' + crypto.randomUUID().replaceAll('-', ''), rollback = Error('ROLLBACK_TOPUP_TEST');
    try {
      await assert.rejects(db.transaction(async trx => {
        await trx.schema.createSchema(schema); await trx.raw('SET LOCAL search_path TO ??', [schema]);
        await trx.raw("CREATE TYPE role_enum AS ENUM ('user', 'admin', 'superadmin', 'member', 'viewer')");
        await trx.schema.createTable('companies', t => { t.uuid('id').primary(); t.string('name'); t.string('status');
          t.decimal('credit_balance', 15, 2); t.jsonb('settings'); t.timestamp('updated_at'); t.timestamp('deleted_at'); });
        await trx.schema.createTable('users', t => { t.uuid('id').primary(); t.uuid('company_id'); t.specificType('role', 'role_enum');
          t.string('status'); t.string('credit_balance'); t.timestamp('deleted_at'); });
        await trx.schema.createTable('credit_transactions', t => { t.uuid('id').primary().defaultTo(trx.raw('gen_random_uuid()'));
          t.uuid('company_id'); t.string('company_name'); t.string('type'); t.decimal('amount', 15, 2);
          t.decimal('balance_before', 15, 2); t.decimal('balance_after', 15, 2); t.string('reference_type');
          t.uuid('reference_id'); t.string('created_by'); t.string('description'); t.jsonb('meta_data'); });
        await trx.schema.createTable('activity_logs', t => { t.uuid('user_id'); t.uuid('company_id'); t.string('action');
          t.string('entity_type'); t.uuid('entity_id'); t.string('description'); t.string('status'); t.boolean('read'); t.jsonb('new_data'); });
        const migration = loadSource('src/database/migrations/20261028000002_credit_topup_orders.ts');
        await migration.up(trx);
        const foreignCompany = crypto.randomUUID(), foreignUser = crypto.randomUUID(), superadmin = crypto.randomUUID();
        await trx('companies').insert([{ id: actor.companyId, name: 'Buyer', status: 'active', credit_balance: '100.00' },
          { id: foreignCompany, name: 'Other company', status: 'active', credit_balance: '50.00' }]);
        await trx('users').insert([{ id: actor.userId, company_id: actor.companyId, role: 'admin', status: 'active' },
          { id: foreignUser, company_id: foreignCompany, role: 'admin', status: 'active' },
          { id: superadmin, company_id: foreignCompany, role: 'superadmin', status: 'active', credit_balance: '5000' }]);
        const qrs = new Map(), payments = new Map(); let creations = 0, failCreation = false;
        const provider = {
          liveCreditConfiguration: () => ({ keyId: 'rzp_live_example' }),
          async createCreditQr(order) {
            creations++; const qr = { entity: 'qr_code', id: 'qr_test' + creations, status: 'active', type: 'upi_qr', usage: 'single_use',
              fixed_amount: true, payment_amount: order.amount_paise, image_url: 'https://rzp.io/i/test',
              notes: { purpose: 'company_credit_topup', credit_topup_id: order.id, company_id: order.company_id, user_id: order.user_id } };
            qrs.set(qr.id, qr); if (failCreation) { failCreation = false; throw Error('timeout after creation'); } return qr;
          },
          fetchCreditQr: async id => qrs.get(id),
          fetchCreditQrPayments: async id => ({ items: payments.has(id) ? [payments.get(id)] : [] }),
          fetchCreditPayment: async id => [...payments.values()].find(payment => payment.id === id),
          recoverCreditQr: async order => [...qrs.values()].find(qr => qr.notes.credit_topup_id === order.id),
        };
        const api = service(trx, provider);
        const balance = async id => (await trx('companies').where({ id: id || actor.companyId }).first()).credit_balance;
        // Match the deployed native enum and re-check the live role, including stale admin claims.
        await trx('users').where({ id: actor.userId }).update({ role: 'viewer' });
        await assert.rejects(api.create(actor, { amount_paise: 15025 }), /Active company administrator/);
        assert.equal(creations, 0);
        await trx('users').where({ id: actor.userId }).update({ role: 'admin' });
        const credit = await api.create(actor, { amount_paise: 15025 });
        assert.equal(credit.status, 'pending'); assert.equal(await balance(), '100.00');
        assert.equal((await api.create(actor, { amount_paise: 15025 })).id, credit.id); assert.equal(creations, 1);
        await assert.rejects(api.create(actor, { amount_paise: 15026 }), /different amount/);
        assert.equal((await api.verify(actor, credit.id)).credits_added, 0);
        await assert.rejects(api.get({ ...actor, companyId: foreignCompany, userId: foreignUser }, credit.id), /not found/);
        const captured = { entity: 'payment', id: 'pay_first', status: 'captured', captured: true,
          amount: 15025, amount_refunded: 0, currency: 'INR', method: 'upi', created_at: Math.floor(Date.now() / 1000) };
        payments.set(credit.qr_code_id, { ...captured, amount: 1 });
        await assert.rejects(api.verify(actor, credit.id), /matching captured/); assert.equal(await balance(), '100.00');
        payments.set(credit.qr_code_id, { ...captured, currency: 'USD' });
        await assert.rejects(api.verify(actor, credit.id), /matching captured/);
        payments.set(credit.qr_code_id, captured);
        const raw = Buffer.from(JSON.stringify({ event: 'qr_code.credited', payload: { qr_code: { entity: { id: credit.qr_code_id } },
          payment: { entity: { amount: 999999999 } } } }));
        assert.equal((await api.webhook(raw, sign(raw), 'evt-one')).processed, true);
        assert.equal(await balance(), '250.25');
        assert.equal((await api.webhook(raw, sign(raw), 'evt-one')).replayed, true);
        assert.equal((await api.verify(actor, credit.id)).credits_added, 150.25);
        assert.equal((await trx('credit_transactions')).length, 1);
        assert.equal((await trx('credit_transactions').first()).amount, '150.25');
        assert.equal((await trx('users').where({ id: superadmin }).first()).credit_balance, '5000');
        assert.equal(await balance(foreignCompany), '50.00');
        captured.amount_refunded = 5000;
        assert.equal((await api.verify(actor, credit.id)).status, 'partially_refunded'); assert.equal(await balance(), '200.25');
        await api.verify(actor, credit.id); assert.equal((await trx('credit_transactions')).length, 2);
        captured.amount_refunded = 0; await api.verify(actor, credit.id); assert.equal(await balance(), '200.25');
        captured.amount_refunded = 15025; captured.status = 'refunded';
        const refund = Buffer.from(JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { payment_id: captured.id } } } }));
        assert.equal((await api.webhook(refund, sign(refund), 'evt-refund')).status, 'refunded');
        assert.equal(await balance(), '100.00'); assert.equal((await trx('credit_transactions')).length, 3);
        await assert.rejects(migration.down(trx), /financial history/);
        // A provider timeout is recovered using the original server notes, without a second POST.
        failCreation = true;
        const recoverActor = { ...actor, idempotencyKey: 'recover' }; let unknown;
        try { await api.create(recoverActor, { amount_paise: 100 }); } catch (error) { unknown = error.details.topup_id; }
        assert.ok(unknown); assert.equal((await api.create(recoverActor, { amount_paise: 100 })).id, unknown);
        assert.equal(creations, 2); assert.equal((await api.verify(actor, unknown)).status, 'pending');
        // A late audit failure must roll back both money and ledger, then allow same-payment retry.
        const late = await api.create({ ...actor, idempotencyKey: 'late-failure' }, { amount_paise: 7700 });
        payments.set(late.qr_code_id, { ...captured, id: 'pay_late', amount: 7700, amount_refunded: 0, status: 'captured' });
        await trx.raw("ALTER TABLE activity_logs ADD CONSTRAINT reject_late_audit CHECK (new_data->>'payment_id' <> 'pay_late') NOT VALID");
        await assert.rejects(api.verify(actor, late.id)); assert.equal(await balance(), '100.00');
        assert.equal((await trx('credit_transactions')).length, 3);
        assert.equal((await trx('credit_topup_orders').where({ id: late.id }).first()).ledger_transaction_id, null);
        await trx.raw('ALTER TABLE activity_logs DROP CONSTRAINT reject_late_audit');
        await api.verify(actor, late.id); assert.equal(await balance(), '177.00');
        assert.equal((await api.list(actor, {})).pagination.total, 3);
        // Exercise competing browser/webhook confirmations. Nested transactions share
        // one test connection; production uses the same order-row lock across connections.
        const competing = await api.create({ ...actor, idempotencyKey: 'competing' }, { amount_paise: 123 });
        payments.set(competing.qr_code_id, { ...captured, id: 'pay_competing', amount: 123, amount_refunded: 0, status: 'captured' });
        const serializedDb = (...args) => trx(...args); serializedDb.fn = trx.fn;
        let tail = Promise.resolve();
        serializedDb.transaction = fn => { const next = tail.then(() => trx.transaction(fn)); tail = next.catch(() => {}); return next; };
        const concurrentApi = service(serializedDb, provider);
        const competingEvent = Buffer.from(JSON.stringify({ event: 'qr_code.credited', payload: { qr_code: { entity: { id: competing.qr_code_id } } } }));
        await Promise.all([concurrentApi.verify(actor, competing.id), concurrentApi.webhook(competingEvent, sign(competingEvent), 'evt-competing')]);
        assert.equal(await balance(), '178.23');
        assert.equal(Number((await trx('credit_transactions').where({ reference_id: competing.id, type: 'credit' }).count('* as count').first()).count), 1);
        throw rollback;
      }), error => error === rollback);
    } finally { await db.destroy(); }
  });

test('mounted credit routes preserve JWT company identity and do not expose platform secrets', async () => {
  const calls = [], noop = (_req, res) => res.json({});
  const controller = loadSource('src/app/http/controllers/creditTopup.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
      successResponse: (_req, res, message, data, code = 200) => res.status(code).json({ success: true, message, data }) },
    '../../services/creditTopup.service': { create: async (context, body) => { calls.push({ context, body }); return { id: 'purchase', qr_image_url: 'https://rzp.io/i/test' }; },
      options: () => ({}), list: async () => ({}), get: async () => ({}), verify: async () => ({}) },
  }).default;
  const route = loadSource('src/routes/creditTopup.route.ts', { express,
    '../app/http/controllers/creditTopup.controller': controller,
    '@surefy/middleware/jwtAuth.middleware': { requireRole: (...roles) => (req, res, next) => roles.includes(req.userRole) ? next() : res.status(403).json({}) },
  }).default;
  const app = express(); app.use(express.json());
  app.use('/v1/admin/credits/topups', (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({});
    Object.assign(req, actor, { userRole: req.headers.authorization }); next();
  }, route);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const send = (role) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/admin/credits/topups', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'checkout-1', ...(role ? { Authorization: role } : {}) } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    }); req.on('error', reject); req.end(JSON.stringify({ amount_paise: 100 }));
  });
  try {
    assert.equal((await send()).status, 401); assert.equal((await send('user')).status, 403);
    assert.equal((await send('superadmin')).status, 403); assert.equal((await send('admin')).status, 201);
    assert.equal(calls.length, 1); assert.equal(calls[0].context.companyId, actor.companyId);
    assert.equal(calls[0].context.userId, actor.userId); assert.equal(calls[0].context.idempotencyKey, 'checkout-1');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('production JSON parser preserves exact signed Razorpay bytes, including trailing slash and query string', async () => {
  const api = service(() => assert.fail('Unexpected database call'), {});
  const router = express.Router();
  router.post('/credits', async (req, res, next) => {
    try { res.json(await api.webhook(req.rawBody, req.get('X-Razorpay-Signature'), 'parser-event')); } catch (error) { next(error); }
  });
  const app = loadSource('library/surefy/src/server.ts', {
    './middleware/requestCapacity': { requestCapacity: () => (_req, _res, next) => next() },
    './utils/asyncRouter': { protectAsyncRoutes() {} },
    './routes/health.route': express.Router(), './middleware/upload.middleware': { UPLOADS_DIR: require('node:path').resolve('.cache') },
    './middleware/errorHandler': { errorHandler: (error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ message: error.message }) },
    './exceptions/CustomError': { CustomError },
  }, { process: { env: { WORKER_MODE: 'true' } } }).default([{ basePath: '/v1/webhooks/razorpay', route: router }]);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const raw = Buffer.from('{\n  "event" : "unrelated.event"\n}');
  const send = (path, signature) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }); req.on('error', reject); req.end(raw);
  });
  try {
    for (const path of ['/v1/webhooks/razorpay/credits', '/v1/webhooks/razorpay/credits/?source=razorpay']) {
      const result = await send(path, sign(raw)); assert.equal(result.status, 200); assert.equal(result.body.ignored, true);
      assert.equal((await send(path, sign(Buffer.from('{}')))).status, 400);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
