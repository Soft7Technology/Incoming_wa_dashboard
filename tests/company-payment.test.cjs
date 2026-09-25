const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

class HTTPError extends Error { constructor({ message }) { super(message); } }
function load(file, dependencies = {}, extra = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, Buffer, Date, ...extra, require(name) {
    if (name in dependencies) return dependencies[name];
    if (name.includes('/exceptions/')) return HTTPError;
    return require(name);
  } });
  return exports;
}
const providerFile = 'src/app/services/paymentGateway.provider.ts';
const serviceFile = 'src/app/services/companyPayment.service.ts';
const credentialFile = 'src/app/utils/paymentCredentials.ts';
const gateway = { provider: 'razorpay', mode: 'test', credentials: { key_id: 'rzp_test_example', key_secret: 'secret-example' } };

test('gateway credentials require an explicit encryption key and are bound to company/configuration', () => {
  const env = {};
  const crypto = load(credentialFile, {}, { process: { env } });
  assert.throws(() => crypto.encryptPaymentCredentials({}, 'company-a'), /must be configured/);
  env.PAYMENT_GATEWAY_ENCRYPTION_KEY = 'ab'.repeat(32);
  const encrypted = crypto.encryptPaymentCredentials(gateway.credentials, 'company-a:version-1');
  assert.ok(!encrypted.includes('secret-example'));
  assert.equal(crypto.decryptPaymentCredentials(encrypted, 'company-a:version-1').key_secret, 'secret-example');
  assert.throws(() => crypto.decryptPaymentCredentials(encrypted, 'company-b:version-1'), /Unable to decrypt/);
  assert.throws(() => crypto.decryptPaymentCredentials(encrypted + 'x', 'company-a:version-1'), /Unable to decrypt/);
});

test('Razorpay order creation sends integer paise and returns public checkout fields only', async () => {
  let sent;
  const api = load(providerFile, { axios: { request: async input => {
    sent = input;
    return { data: { id: 'order_1', amount: 100, currency: 'INR' } };
  } } });
  const result = await api.createGatewayOrder(gateway, { id: 'local-1', amount_paise: 100, user_id: 'u', display_name: 'Company A' });
  assert.equal(sent.baseURL, 'https://api.razorpay.com/v1');
  assert.equal(sent.data.amount, 100);
  assert.equal(sent.auth.password, 'secret-example');
  assert.equal(result.checkout.key, 'rzp_test_example');
  assert.ok(!JSON.stringify(result).includes('secret-example'));
});

test('Cashfree switches sandbox/live hosts and converts paise to rupees', async () => {
  for (const mode of ['test', 'live']) {
    let sent;
    const api = load(providerFile, { axios: { request: async input => {
      sent = input;
      return { data: { order_id: 'local-1', order_amount: 1.25, order_currency: 'INR', payment_session_id: 'session_1' } };
    } } });
    const result = await api.createGatewayOrder({ ...gateway, provider: 'cashfree', mode }, {
      id: 'local-1', amount_paise: 125, user_id: 'u', customer_phone: '9999999999', display_name: 'Company A',
    });
    assert.equal(sent.baseURL, mode === 'test' ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg');
    assert.equal(sent.data.order_amount, 1.25);
    assert.equal(sent.headers['x-idempotency-key'], 'local-1');
    assert.equal(result.checkout.payment_session_id, 'session_1');
  }
});

test('verification requires matching identity, currency, amount and captured/paid state', async () => {
  let data = { id: 'order_1', currency: 'INR', amount: 100, amount_paid: 100, amount_due: 0, status: 'paid' };
  const api = load(providerFile, { axios: { request: async () => ({ data }) } });
  const order = { provider_order_id: 'order_1', amount_paise: 100 };
  assert.equal(await api.verifyGatewayOrder(gateway, order), true);
  data.status = 'attempted';
  assert.equal(await api.verifyGatewayOrder(gateway, order), false);
  data = { ...data, status: 'paid', amount_due: 50 };
  assert.equal(await api.verifyGatewayOrder(gateway, order), false);
  for (const mutation of [{ amount: 200 }, { currency: 'USD' }, { id: 'another-order' }]) {
    const original = data;
    data = { ...data, ...mutation };
    await assert.rejects(api.verifyGatewayOrder(gateway, order), /does not match/);
    data = original;
  }
  data = { order_id: 'order_1', order_amount: 1, order_currency: 'INR', order_status: 'PAID' };
  assert.equal(await api.verifyGatewayOrder({ ...gateway, provider: 'cashfree' }, order), true);
  data.order_status = 'ACTIVE';
  assert.equal(await api.verifyGatewayOrder({ ...gateway, provider: 'cashfree' }, order), false);
});

test('provider errors never expose credential-bearing Axios errors', async () => {
  const api = load(providerFile, { axios: { request: async () => { throw new Error('secret-example'); } } });
  await assert.rejects(api.verifyGatewayOrder(gateway, { provider_order_id: 'o', amount_paise: 100 }), error => {
    assert.match(error.message, /Gateway request failed/);
    assert.ok(!error.message.includes('secret-example'));
    return true;
  });
});

// A small query stub exercises service ownership and idempotency without a live database.
function harness() {
  const rows = {
    companies: [{ id: 'company-a' }, { id: 'company-b' }],
    company_payment_gateways: [{ id: 'gateway-a', company_id: 'company-a', mode: 'test', provider: 'razorpay', active: true, display_name: 'A' }],
    company_payment_orders: [],
  };
  const db = table => {
    let predicates = [], operation, values;
    const matches = row => predicates.every(predicate => predicate(row));
    const execute = () => {
      if (operation === 'insert') { const row = { ...values }; rows[table].push(row); operation = undefined; return [row]; }
      const selected = rows[table].filter(matches);
      if (operation === 'update') selected.forEach(row => Object.assign(row, values));
      return selected.map(row => ({ ...row }));
    };
    const query = {
      where(data) { predicates.push(row => Object.entries(data).every(([k, v]) => row[k] === v)); return query; },
      andWhere(data) { return query.where(data); },
      whereNot(key, value) { predicates.push(row => row[key] !== value); return query; },
      forUpdate() { return query; },
      first() { return Promise.resolve(execute()[0]); },
      insert(data) { operation = 'insert'; values = data; return query; },
      update(data) { operation = 'update'; values = data; return query; },
      returning() { return Promise.resolve(execute()); },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    return query;
  };
  db.transaction = fn => fn(db);
  let creates = 0, verifies = 0, fail = false;
  const api = load(serviceFile, {
    '@surefy/database': db,
    '../models/companyPayment.model': load('src/app/models/companyPayment.model.ts', { '@surefy/database': db }).default,
    '../utils/paymentCredentials': { decryptPaymentCredentials: () => gateway.credentials, encryptPaymentCredentials: () => 'encrypted' },
    './paymentGateway.provider': {
      createGatewayOrder: async () => { creates++; if (fail) throw new Error('Timeout'); return { provider_order_id: 'order_1', checkout: {} }; },
      verifyGatewayOrder: async () => { verifies++; return true; },
    },
  });
  const req = { companyId: 'company-a', userId: 'user-a', userRole: 'admin', idempotencyKey: 'retry-key-1' };
  return { ...api, rows, req, counts: () => ({ creates, verifies }), fail: () => { fail = true; } };
}

test('company context and administrator role are mandatory for configuration and order creation', async () => {
  const h = harness();
  assert.throws(() => h.paymentScope({ userId: 'u' }), /company context/);
  await assert.rejects(h.default.create({ ...h.req, userRole: 'user' }, {}, true), /Only company administrators/);
  await assert.rejects(h.default.configure({ ...h.req, userRole: 'user' }, {}), /Only company administrators/);
  for (const value of [0, 99, 100.5, '100', NaN, Infinity, 100000001]) assert.throws(() => h.paymentAmount(value), /amount_paise/);
  assert.equal(h.paymentAmount(100), 100);
});

test('test orders force INR 1 and cannot use live mode; repeated requests reuse the order', async () => {
  const h = harness();
  await assert.rejects(h.default.create(h.req, { mode: 'live' }, true), /only accepts test/);
  await assert.rejects(h.default.create(h.req, { amount_paise: 200 }, true), /fixed amount/);
  const first = await h.default.create(h.req, {}, true);
  const second = await h.default.create(h.req, {}, true);
  assert.equal(first.id, second.id);
  assert.equal(first.amount_paise, 100);
  assert.equal(first.is_test, true);
  assert.equal(h.counts().creates, 1);
  await assert.rejects(h.default.create(h.req, { mode: 'test', amount_paise: 200 }), /different payment request/);
});

test('failed order creation is retained and is not automatically retried at the gateway', async () => {
  const h = harness();
  h.fail();
  await assert.rejects(h.default.create(h.req, {}, true), /Timeout/);
  const retry = await h.default.create(h.req, {}, true);
  assert.equal(retry.status, 'creation_unknown');
  assert.equal(h.counts().creates, 1);
});

test('orders are isolated by company and user; verification is idempotent', async () => {
  const h = harness();
  const order = await h.default.create(h.req, {}, true);
  await assert.rejects(h.default.get({ ...h.req, companyId: 'company-b' }, order.id), /not found/);
  await assert.rejects(h.default.verify({ ...h.req, companyId: 'company-b' }, order.id), /not found/);
  await assert.rejects(h.default.get({ ...h.req, userId: 'user-b', userRole: 'user' }, order.id), /not found/);
  assert.equal(h.counts().verifies, 0);
  const paid = await h.default.verify(h.req, order.id);
  assert.equal(paid.status, 'paid');
  await h.default.verify(h.req, order.id);
  assert.equal(h.counts().verifies, 1);
});

test('reconfiguring a company does not change the gateway of existing orders', async () => {
  const h = harness();
  const order = await h.default.create(h.req, {}, true);
  await h.default.configure(h.req, { provider: 'razorpay', mode: 'test', key_id: 'rzp_test_new', key_secret: 'new', display_name: 'New' });
  assert.equal(h.rows.company_payment_gateways[0].active, false);
  assert.equal(h.rows.company_payment_orders[0].gateway_id, 'gateway-a');
  assert.equal((await h.default.verify(h.req, order.id)).status, 'paid');
});
