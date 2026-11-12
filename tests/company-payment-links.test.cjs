const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createHmac } = require('node:crypto');

class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, Date, Buffer, URL, console, __dirname: require('node:path').dirname(require('node:path').resolve(file)), ...globals,
    require: id => id in deps ? deps[id] : id.includes('/exceptions/') ? HttpError : require(id) });
  return exports;
}
const purchase = { id: '00000000-0000-4000-8000-000000000001', amount_paise: 100000, customer_phone: '9999999999' };
const gateway = { provider: 'razorpay', mode: 'test', credentials: { key_id: 'rzp_test_example', key_secret: 'test-secret' } };
const validLink = () => ({ id: 'plink_123', reference_id: purchase.id, amount: 100000, amount_paid: 0,
  currency: 'INR', accept_partial: false, status: 'created', short_url: 'https://rzp.io/i/example', expire_by: 2000000000 });

test('provider creates a fixed-price link with Basic Auth and a purchase-specific reference', async () => {
  let request;
  const provider = load('src/app/services/paymentGateway.provider.ts', { axios: { request: async args => { request = args; return { data: validLink() }; } } });
  const result = await provider.createGatewayPaymentLink(gateway, purchase);
  assert.equal(request.url, '/payment_links'); assert.equal(request.method, 'POST');
  assert.equal(request.auth.username, gateway.credentials.key_id); assert.equal(request.auth.password, gateway.credentials.key_secret);
  assert.equal(request.data.amount, 100000); assert.equal(request.data.accept_partial, false);
  assert.equal(request.data.reference_id, purchase.id); assert.equal(request.data.notify.sms, false);
  assert.equal(result.id, 'plink_123');
  await assert.rejects(provider.createGatewayPaymentLink({ ...gateway, provider: 'cashfree' }, purchase), /Razorpay/);
});

test('provider rejects mismatched price, currency, reference, identity and unsafe checkout URLs', async () => {
  for (const mutation of [{ amount: 100 }, { currency: 'USD' }, { reference_id: 'other' }, { id: 'plink_other' },
    { accept_partial: true }, { short_url: 'javascript:alert(1)' }, { short_url: 'https://attacker.example/pay' }]) {
    const provider = load('src/app/services/paymentGateway.provider.ts', { axios: { request: async () => ({ data: { ...validLink(), ...mutation } }) } });
    await assert.rejects(provider.fetchGatewayPaymentLink(gateway, { ...purchase, provider_payment_link_id: 'plink_123' }));
  }
});

test('unknown creation is recovered by reference using GET and ambiguous results are rejected', async () => {
  let response = { payment_links: [validLink()] }, requests = [];
  const provider = load('src/app/services/paymentGateway.provider.ts', { axios: { request: async args => { requests.push(args); return { data: response }; } } });
  assert.equal((await provider.fetchGatewayPaymentLink(gateway, purchase)).id, 'plink_123');
  assert.equal(requests[0].method, 'GET'); assert.ok(requests[0].url.includes(`reference_id=${purchase.id}`));
  response = { payment_links: [] }; assert.equal(await provider.fetchGatewayPaymentLink(gateway, purchase), null);
  response = { payment_links: [validLink(), validLink()] };
  await assert.rejects(provider.fetchGatewayPaymentLink(gateway, purchase), /Multiple/);
  response = {}; await assert.rejects(provider.fetchGatewayPaymentLink(gateway, purchase), /Unexpected/);
});

test('provider errors never expose API secrets from Axios request metadata', async () => {
  const provider = load('src/app/services/paymentGateway.provider.ts', { axios: { request: async () => { throw Error('test-secret'); } } });
  await assert.rejects(provider.createGatewayPaymentLink(gateway, purchase), error => !error.message.includes('test-secret'));
});

test('capture verification rejects authorized, refunded, partial and unrelated payments', async () => {
  const payment = { id: 'pay_123', order_id: 'order_123', status: 'captured', captured: true, amount: 100000, amount_refunded: 0, currency: 'INR' };
  let current = payment;
  const provider = load('src/app/services/paymentGateway.provider.ts', { axios: { request: async args => {
    assert.equal(args.url, '/orders/order_123/payments'); return { data: { items: [current] } };
  } } });
  const link = { ...validLink(), status: 'paid', amount_paid: 100000, order_id: 'order_123' };
  assert.equal(await provider.paymentLinkHasCapturedPayment(gateway, link, purchase), true);
  for (const mutation of [{ status: 'authorized' }, { captured: false }, { amount_refunded: 1 }, { amount: 100 }, { order_id: 'order_other' }, { currency: 'USD' }]) {
    current = { ...payment, ...mutation };
    assert.equal(await provider.paymentLinkHasCapturedPayment(gateway, link, purchase), false);
  }
});

function webhookHarness() {
  const config = { id: '00000000-0000-4000-8000-000000000002', company_id: 'company-a', provider: 'razorpay', mode: 'test', webhook_secret_configured: true, webhook_verified_at: null, credentials_encrypted: 'cipher' };
  const configs = [config];
  const orders = [{ id: purchase.id, company_id: config.company_id, gateway_id: config.id,
    payment_flow: 'link', provider_payment_link_id: 'plink_123', fulfilled_at: null, next_check_at: null }];
  const db = table => {
    const predicates = [];
    const q = {
      where(field, value) {
        if (typeof field === 'function') {
          let checks = [];
          const group = { whereNull(key) { checks.push(row => row[key] == null); return group; },
            orWhere(key, val) { checks.push(row => row[key] === val); return group; } };
          field.call(group); predicates.push(row => checks.some(check => check(row)));
        } else predicates.push(row => Object.entries(field).every(([key, val]) => row[key] === val));
        return q;
      },
      whereNull(key) { predicates.push(row => row[key] == null); return q; },
      async first() { return (table === 'company_payment_gateways' ? configs : orders).find(row => predicates.every(check => check(row))); },
      async update(data) { const selected = (table === 'company_payment_gateways' ? configs : orders).filter(row => predicates.every(check => check(row))); selected.forEach(row => Object.assign(row, data)); return selected.length; },
    };
    return q;
  };
  const service = load('src/app/services/companyPaymentLinkWebhook.service.ts', {
    '@surefy/database': db, '../utils/paymentCredentials': { decryptPaymentCredentials: () => ({ webhook_secret: 'webhook-secret' }) },
  });
  const payload = (changes = {}) => Buffer.from(JSON.stringify({ event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: 'plink_123', reference_id: purchase.id, ...changes } } } }));
  const sign = body => createHmac('sha256', 'webhook-secret').update(body).digest('hex');
  return { config, configs, orders, service, payload, sign };
}

test('signature validation uses exact bytes and rejects missing/malformed/tampered signatures', async () => {
  const h = webhookHarness(), raw = h.payload();
  assert.equal(h.service.validPaymentLinkSignature(raw, h.sign(raw), 'webhook-secret'), true);
  for (const signature of [undefined, 'bad', '0'.repeat(64)]) {
    await assert.rejects(h.service.receivePaymentLinkWebhook(h.config.id, raw, signature), /signature/);
  }
  await assert.rejects(h.service.receivePaymentLinkWebhook(h.config.id, Buffer.concat([raw, Buffer.from(' ')]), h.sign(raw)), /signature/);
  assert.equal(h.orders[0].next_check_at, null);
  assert.equal(h.config.webhook_verified_at, null);
});

test('signed supported delivery verifies only its configuration, preserves first timestamp, and grants no access', async () => {
  const h = webhookHarness();
  h.config.active = false;
  const newer = { ...h.config, id: '00000000-0000-4000-8000-000000000003', active: true };
  const live = { ...h.config, id: '00000000-0000-4000-8000-000000000004', mode: 'live', active: true };
  const otherCompany = { ...h.config, id: '00000000-0000-4000-8000-000000000005', company_id: 'company-b', active: true };
  h.configs.push(newer, live, otherCompany);
  // A dashboard-created link has no app purchase reference, but proves delivery.
  const raw = h.payload({ reference_id: 'dashboard-link' });
  await h.service.receivePaymentLinkWebhook(h.config.id, raw, h.sign(raw));
  const verifiedAt = h.config.webhook_verified_at;
  assert.ok(verifiedAt instanceof Date);
  await h.service.receivePaymentLinkWebhook(h.config.id, raw, h.sign(raw));
  assert.equal(h.config.webhook_verified_at, verifiedAt);
  for (const config of [newer, live, otherCompany]) assert.equal(config.webhook_verified_at, null);
  assert.equal(h.orders[0].fulfilled_at, null); assert.equal(h.orders[0].next_check_at, null);
});

test('signed malformed JSON, unrelated events and invalid link payloads do not verify the gateway', async () => {
  const h = webhookHarness();
  const broken = Buffer.from('{');
  await assert.rejects(h.service.receivePaymentLinkWebhook(h.config.id, broken, h.sign(broken)), /JSON/);
  for (const raw of [Buffer.from('{"event":"unrelated.event"}'), h.payload({ id: 'invalid' }),
    Buffer.from('{"event":"payment_link.paid"}')]) {
    await h.service.receivePaymentLinkWebhook(h.config.id, raw, h.sign(raw));
    assert.equal(h.config.webhook_verified_at, null);
  }
});

test('gateway API exposes server-derived verification states and ignores client assertions when saving', async () => {
  const timestamp = new Date('2026-11-04T10:00:00Z');
  let records = [
    { id: 'missing', provider: 'razorpay', webhook_secret_configured: false, webhook_verified_at: null },
    { id: 'pending', provider: 'razorpay', webhook_secret_configured: true, webhook_verified_at: null },
    { id: 'verified', provider: 'razorpay', webhook_secret_configured: true, webhook_verified_at: timestamp },
    { id: 'cashfree', provider: 'cashfree', webhook_secret_configured: false, webhook_verified_at: null },
  ];
  const model = {
    activeConfigurations: async companyId => { assert.equal(companyId, 'company-a'); return records; },
    lockCompany: async () => ({ id: 'company-a' }), deactivateGateways: async () => {},
    insertGateway: async (_trx, data) => { records = [{ ...data, webhook_verified_at: null }]; },
  };
  const service = load('src/app/services/companyPayment.service.ts', {
    './paymentPlan.service': {}, './planAddon.service': {}, '@surefy/database': { transaction: async fn => fn({}) },
    '../models/companyPayment.model': model, '../utils/paymentCredentials': { encryptPaymentCredentials: () => 'cipher' },
    './paymentGateway.provider': {},
  }).default;
  const actor = { companyId: 'company-a', userId: 'admin', userRole: 'admin' };
  const states = await service.configurations(actor);
  assert.deepEqual(Array.from(states, row => row.webhook_status), ['not_configured', 'pending', 'verified', 'not_applicable']);
  assert.equal(states[2].webhook_verified, true); assert.equal(states[2].webhook_verified_at, timestamp);
  assert.equal(states[2].webhook_path, '/v1/webhooks/razorpay/company-payments/verified');
  await assert.rejects(service.configurations({ ...actor, userRole: 'user' }), /administrators/);
  const saved = await service.configure(actor, { provider: 'razorpay', mode: 'live', display_name: 'Company',
    key_id: 'rzp_live_example', key_secret: 'api-secret', webhook_secret: 'webhook-secret',
    webhook_verified: true, webhook_verified_at: timestamp, webhook_status: 'verified' });
  assert.equal(saved.webhook_status, 'pending'); assert.equal(saved.webhook_verified, false);
  assert.equal(saved.webhook_verified_at, null);
  assert.equal((await service.configurations(actor))[0].webhook_status, 'pending');
});

test('verified duplicate webhooks durably wake only the matching merchant purchase without granting access', async () => {
  const h = webhookHarness(), raw = h.payload();
  for (let i = 0; i < 2; i++) await h.service.receivePaymentLinkWebhook(h.config.id, raw, h.sign(raw));
  assert.ok(h.orders[0].next_check_at instanceof Date); assert.equal(h.orders[0].fulfilled_at, null);
  for (const mutation of [{ company_id: 'other' }, { gateway_id: 'other' }, { provider_payment_link_id: 'plink_other' }]) {
    const foreign = webhookHarness(); Object.assign(foreign.orders[0], mutation);
    await foreign.service.receivePaymentLinkWebhook(foreign.config.id, raw, foreign.sign(raw));
    assert.equal(foreign.orders[0].next_check_at, null);
  }
  h.orders[0].fulfilled_at = new Date(); h.orders[0].next_check_at = null;
  await h.service.receivePaymentLinkWebhook(h.config.id, raw, h.sign(raw));
  assert.equal(h.orders[0].next_check_at, null);
});

test('a webhook arriving before the create response can wake the saved purchase by reference', async () => {
  const h = webhookHarness(); h.orders[0].provider_payment_link_id = null;
  const raw = h.payload(); await h.service.receivePaymentLinkWebhook(h.config.id, raw, h.sign(raw));
  assert.ok(h.orders[0].next_check_at); assert.equal(h.orders[0].provider_payment_link_id, null);
});

test('production JSON parser preserves signed company-payment bytes with query strings and trailing slashes', async () => {
  const express = require('express'), http = require('node:http'), h = webhookHarness();
  const router = express.Router();
  router.post('/company-payments/:gatewayId', async (req, res, next) => {
    try { res.json(await h.service.receivePaymentLinkWebhook(req.params.gatewayId, req.rawBody, req.get('X-Razorpay-Signature'))); }
    catch (error) { next(error); }
  });
  const app = load('library/surefy/src/server.ts', {
    '@surefy/console/services/dashboardOrigin.service': { isDashboardOriginAllowed: async () => false },
    './middleware/requestCapacity': { requestCapacity: () => (_req, _res, next) => next() },
    './utils/asyncRouter': { protectAsyncRoutes() {} }, './routes/health.route': express.Router(),
    './middleware/upload.middleware': { UPLOADS_DIR: require('node:path').resolve('.cache') },
    './middleware/errorHandler': { errorHandler: (error, _req, res, _next) => res.status(400).json({ message: error.message }) },
    './exceptions/CustomError': { CustomError: HttpError },
  }, { process: { env: { WORKER_MODE: 'true' } } }).default([{ basePath: '/v1/webhooks/razorpay', route: router }]);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const raw = Buffer.from('{\n "event" : "unrelated.event"\n}');
  const send = (path, signature) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.end(raw);
  });
  try {
    for (const suffix of ['', '/?source=razorpay']) {
      const path = `/v1/webhooks/razorpay/company-payments/${h.config.id}${suffix}`;
      assert.equal(await send(path, h.sign(raw)), 200);
      assert.equal(await send(path, h.sign(Buffer.from('{}'))), 400);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('mounted dashboard payment-link route forwards authenticated identity and the retry key', async () => {
  const express = require('express'), http = require('node:http'), calls = [];
  const controller = load('src/app/http/controllers/payment.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
      successResponse: (_req, res, message, data) => res.json({ success: true, message, data }) },
    '../../services/companyPayment.service': { createPaymentLink: async (context, body) => { calls.push({ context, body }); return { id: purchase.id, payment_url: 'https://rzp.io/i/example' }; } },
    '../../services/companyPaymentLinkWebhook.service': { receivePaymentLinkWebhook() {} },
  }).default;
  const router = load('src/routes/payment.route.ts', { '../app/http/controllers/payment.controller': controller }).default;
  const app = express(); app.use(express.json());
  app.use('/v1/admin/payments', (req, res, next) => {
    if (!req.headers.authorization) return res.sendStatus(401);
    Object.assign(req, { companyId: 'authenticated-company', userId: 'authenticated-user', userRole: 'user' }); next();
  }, router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const send = auth => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/admin/payments/payment-links', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'purchase-once', ...(auth ? { Authorization: 'Bearer test' } : {}) } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; }); response.on('end', () => resolve({ status: response.statusCode, raw, headers: response.headers }));
    }); request.on('error', reject); request.end(JSON.stringify({ subscription_plan_id: purchase.id }));
  });
  try {
    assert.equal((await send(false)).status, 401);
    const result = await send(true); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(result.raw).data.payment_url, 'https://rzp.io/i/example');
    assert.equal(calls[0].context.companyId, 'authenticated-company'); assert.equal(calls[0].context.userId, 'authenticated-user');
    assert.equal(calls[0].context.idempotencyKey, 'purchase-once');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('reconciliation leases due purchases, retries failures and persists completion across scheduler restarts', async () => {
  const rows = [1, 2, 3].map(id => ({ id: String(id), company_id: 'company', user_id: 'user',
    payment_flow: 'link', next_check_at: new Date(0) }));
  let calls = [];
  const db = () => {
    const filters = []; let update;
    const execute = () => {
      const selected = rows.filter(row => filters.every(predicate => predicate(row)));
      if (update) selected.forEach(row => Object.assign(row, update));
      return selected.map(row => ({ ...row }));
    };
    const equal = (a, b) => a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
    const q = { where(key, operator, value) {
      filters.push(typeof key === 'string' ? row => row[key] != null && row[key] <= value :
        row => Object.entries(key).every(([field, val]) => equal(row[field], val)));
      return q;
    }, orderBy() { return q; }, forUpdate() { return q; }, skipLocked() { return q; },
    async first() { return execute()[0]; }, update(data) { update = data; return q; },
    then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); } };
    return q;
  };
  db.schema = { hasColumn: async () => true }; db.transaction = async fn => fn(db);
  const deps = { '@surefy/database': db, './companyPayment.service': { verify: async (context, id) => {
    calls.push(id); assert.equal(context.companyId, 'company');
    if (id === '1') throw Error('temporary provider failure');
    if (id === '2') return { status: 'paid', fulfilled_at: new Date() };
    return { status: 'pending', link_status: 'expired' };
  } } };
  await load('src/app/services/companyPaymentLinkScheduler.service.ts', deps).default.tick();
  assert.deepEqual(calls, ['1', '2', '3']); assert.ok(rows[0].next_check_at > new Date());
  assert.equal(rows[1].next_check_at, null); assert.equal(rows[2].next_check_at, null);
  calls = [];
  await load('src/app/services/companyPaymentLinkScheduler.service.ts', deps).default.tick();
  assert.deepEqual(calls, []);
  rows[0].next_check_at = new Date(0);
  await load('src/app/services/companyPaymentLinkScheduler.service.ts', deps).default.tick();
  assert.deepEqual(calls, ['1']);
});

test('add-on payment links reject client prices, invalid quantities and mixed purchases before writing', async () => {
  let writes = 0;
  const service = load('src/app/services/companyPayment.service.ts', {
    './paymentPlan.service': {}, './planAddon.service': {},
    '@surefy/database': { transaction: async () => { writes++; throw Error('unexpected database write'); } },
    '../models/companyPayment.model': {}, '../utils/paymentCredentials': {}, './paymentGateway.provider': {},
  }).default;
  const actor = { companyId: 'company-a', userId: 'user-a', userRole: 'user', idempotencyKey: 'addon-once' };
  const valid = { purchase_type: 'addon', addon_id: purchase.id, user_plan_id: purchase.id, quantity: 1 };
  for (const body of [{ ...valid, amount_paise: 1 }, { ...valid, quantity: 0 }, { ...valid, quantity: 21 },
    { ...valid, quantity: 1.5 }, { ...valid, addon_id: 'bad' }, { ...valid, subscription_plan_id: purchase.id }]) {
    await assert.rejects(service.createPaymentLink(actor, body), error => !error.message.includes('unexpected database write'));
  }
  assert.equal(writes, 0);
});

test('add-on quotes enforce plan ownership and company wallet funding', async () => {
  let balance = '50.00';
  const trx = () => ({ where() { return this; }, async first() { return { credit_balance: balance }; } });
  const quote = { total_price_paise: 1000, platform_fee_paise: 500 };
  const service = load('src/app/services/companyPayment.service.ts', {
    './paymentPlan.service': {}, './planAddon.service': { __esModule: true,
      default: { quote: async () => ({ plan: { user_id: 'plan-owner' }, quote }) }, walletPaise: value => Math.round(Number(value) * 100) },
    '@surefy/database': {}, '../models/companyPayment.model': {}, '../utils/paymentCredentials': {}, './paymentGateway.provider': {},
  }).default;
  const actor = { userId: 'other-user', userRole: 'user' };
  await assert.rejects(service.quoteAddon(trx, actor, 'company-a', {}), /own plan/);
  assert.equal(await service.quoteAddon(trx, { ...actor, ownerId: 'plan-owner' }, 'company-a', {}), quote);
  balance = '0.00';
  await assert.rejects(service.quoteAddon(trx, { ...actor, ownerId: 'plan-owner' }, 'company-a', {}), /Not enough credits/);
});
