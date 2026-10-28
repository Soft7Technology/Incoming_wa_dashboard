const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const knex = require('knex');
const express = require('express');
const jwt = require('jsonwebtoken');

function load(file, dependencies = {}) {
  const exports = {};
  const normalize = id => id.startsWith('@surefy/') ? path.resolve('library/surefy/src', id.slice(8)) : id.startsWith('.') ? path.resolve(path.dirname(file), id) : id;
  const injected = new Map(Object.entries(dependencies).map(([id, value]) => [normalize(id), value]));
  const compiled = process.env.AUTOMATION_TEST_COMPILED_ROOT;
  const code = compiled ? fs.readFileSync(path.join(compiled, file.replace(/\.ts$/, '.js')), 'utf8') : require('typescript').transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: 7, module: 1, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, require: id => injected.has(normalize(id)) ? injected.get(normalize(id)) : require(id), process, Buffer, URL, URLSearchParams, Date, console, setInterval, clearInterval, setTimeout, clearTimeout, __dirname: path.dirname(path.resolve(file)), __filename: path.resolve(file) }, { filename: file });
  return exports;
}
class CustomError extends Error {
  constructor(message, statusCode) { super(message); this.statusCode = statusCode; this.isOperational = true; }
}
const errors = { '@surefy/exceptions/CustomError': { CustomError } };
for (const code of [400, 401, 403, 404]) errors['@surefy/exceptions/HTTP' + code + 'Error'] = class extends CustomError { constructor({ message }) { super(message, code); } };
// The phone library tests options with instanceof Object; bridge VM-created options into its realm.
const phoneLibrary = require('libphonenumber-js');
const utils = load('src/app/utils/automationFlow.ts', { ...errors, 'libphonenumber-js': {
  parsePhoneNumberFromString: (value, options) => phoneLibrary.parsePhoneNumberFromString(value, { ...options }),
} });
const automationTemplates = load('src/app/utils/automationTemplate.ts', { './automationFlow': utils });
const signingSecret = 'isolated-webhook-signing-secret-1234';
const key = Buffer.alloc(32, 8).toString('base64');
const es = value => ({ __esModule: true, default: value });

test('automation mappings preserve scalar types and reject prototype access and unsafe parameters', () => {
  const context = { trigger: { name: '#1001', amount: 500 }, steps: { earlier: { spreadsheetId: 'test_sheet_id' } } };
  assert.equal(utils.resolveParameters('{{trigger.amount}}', context), 500);
  assert.equal(utils.resolveParameters('Order {{trigger.name}}', context), 'Order #1001');
  assert.equal(utils.resolveParameters('{{steps.earlier.spreadsheetId}}', context), 'test_sheet_id');
  for (const template of ['{{trigger.__proto__}}', '{{trigger.constructor}}', '{{process.env}}', '{{trigger.missing}}']) assert.throws(() => utils.resolveParameters(template, context));
  const definition = utils.action('razorpay', 'createPaymentLink');
  assert.throws(() => utils.validateParameters(definition, { amount_paise: 1.5, description: 'Test' }));
  assert.throws(() => utils.validateParameters(definition, { amount_paise: 500, description: 'Test', url: 'http://127.0.0.1' }));
  assert.throws(() => utils.action('http', 'request'));
});

test('Shopify order rows include the customer name and allow absent customer details', () => {
  const parameters = { spreadsheet_id: 'spreadsheet_test_123', range: "'Sheet1'!A2:C", values: [['{{trigger.id}}', '{{contact.name}}', '{{trigger.total_price}}']] };
  const definition = utils.action('google-sheets', 'appendRows');
  const cases = [
    [{ first_name: ' Rahul ', last_name: ' Sharma ' }, 'Rahul Sharma'],
    [{ first_name: 'Rahul', last_name: null }, 'Rahul'],
    [null, null],
    [undefined, null],
    [{ first_name: 123, last_name: '' }, null],
  ];
  for (const [customer, name] of cases) {
    const trigger = { id: 1001, customer, total_price: '1500.00' };
    const before = JSON.stringify(trigger);
    const resolved = utils.validateParameters(definition, utils.resolveParameters(parameters, { trigger, contact: utils.shopifyContact(trigger) }));
    assert.equal(JSON.stringify(resolved.values), JSON.stringify([[1001, name, '1500.00']]));
    assert.equal(JSON.stringify(trigger), before);
  }
});

test('provider webhook signatures authenticate the exact original bytes', () => {
  const raw = Buffer.from('{ "event": "payment.captured" }');
  for (const provider of ['shopify', 'razorpay']) {
    const signature = crypto.createHmac('sha256', signingSecret).update(raw).digest(provider === 'shopify' ? 'base64' : 'hex');
    utils.verifySignature(raw, signature, signingSecret, provider);
    assert.throws(() => utils.verifySignature(Buffer.from('{}'), signature, signingSecret, provider));
    assert.throws(() => utils.verifySignature(raw, signature, 'wrong secret', provider));
  }
});

test('Shopify contact mappings distinguish buyer and delivery phones and require valid international numbers', () => {
  const sample = { phone: 'invalid', customer: { phone: '+1 (202) 555-0123' }, billing_address: { phone: '+442079460018' }, shipping_address: { phone: '+442079460019' } };
  const before = JSON.stringify(sample), contact = utils.shopifyContact(sample);
  assert.equal(contact.phone, '+12025550123'); assert.equal(contact.phone_source, 'customer.phone');
  assert.equal(contact.phone_status, 'available'); assert.equal(contact.shipping_phone, '+442079460019');
  assert.equal(utils.resolveParameters('{{contact.phone}}', { contact }), '+12025550123');
  assert.equal(JSON.stringify(sample), before);
  assert.equal(utils.shopifyContact({ phone: '00442079460018' }).phone, '+442079460018');
  assert.equal(utils.shopifyContact({ phone: '+12025550123', customer: { phone: '+442079460018' } }).phone_source, 'phone');
  assert.equal(utils.shopifyContact({ billing_address: { phone: '+442079460018' } }).phone_source, 'billing_address.phone');
  const deliveryOnly = utils.shopifyContact({ shipping_address: { phone: '+442079460019' } });
  assert.equal(deliveryOnly.phone, null); assert.equal(deliveryOnly.phone_status, 'missing');
  assert.equal(deliveryOnly.shipping_phone_status, 'available');
  for (const value of ['2025550123', '+123', '+12025550123 ext. 8', 'Phone: +12025550123', 12025550123]) {
    const invalid = utils.shopifyContact({ phone: value }); assert.equal(invalid.phone, null); assert.equal(invalid.phone_status, 'invalid');
  }
  assert.equal(utils.shopifyContact({ customer: null }).phone_status, 'missing');
});

test('automation credentials and captured payloads are encrypted and bound to their context', () => {
  const prior = process.env.AUTOMATION_ENCRYPTION_KEY; process.env.AUTOMATION_ENCRYPTION_KEY = key;
  try {
    const encrypted = utils.encrypt({ secret: 'private-credential' }, 'owner-a');
    assert.equal(encrypted.includes('private-credential'), false);
    assert.equal(utils.decrypt(encrypted, 'owner-a').secret, 'private-credential');
    assert.throws(() => utils.decrypt(encrypted, 'owner-b'));
  } finally { if (prior === undefined) delete process.env.AUTOMATION_ENCRYPTION_KEY; else process.env.AUTOMATION_ENCRYPTION_KEY = prior; }
});

test('Google Sheets flow requests use fixed hosts, bounded ranges and RAW writes', async () => {
  const requests = [];
  const axios = { request: async request => { requests.push(request); return { data: { spreadsheetId: 'spreadsheet_test_123' } }; } };
  const { GoogleSheetsClient } = load('src/app/services/googleSheetsClient.service.ts', { axios: es(axios), '../utils/googleSheets': { fail: utils.fail } });
  const client = new GoogleSheetsClient();
  await client.automation('createSpreadsheet', { title: 'Orders', sheet_title: 'New orders' }, 'private-access-token');
  assert.equal(requests[0].url, 'https://sheets.googleapis.com/v4/spreadsheets');
  assert.equal(requests[0].data.properties.title, 'Orders');
  await client.automation('appendRows', { spreadsheet_id: 'spreadsheet_test_123', range: "'New orders'!A1:C", values: [['=IMPORTXML(1)', 500, true]] }, 'private-access-token');
  assert.equal(requests[1].params.valueInputOption, 'RAW');
  assert.equal(requests[1].method, 'post');
  assert.ok(requests[1].url.endsWith(':append'));
  await client.automation('updateRows', { spreadsheet_id: 'spreadsheet_test_123', range: "'New orders'!A2:C2", values: [['Updated', 500, true]] }, 'private-access-token');
  assert.equal(requests[2].method, 'put');
  for (const range of ['Sheet1!A1:C', 'Sheet1!A1:C2000', 'Sheet1!A1:ZZ2']) await assert.rejects(client.automation('getRows', { spreadsheet_id: 'spreadsheet_test_123', range }, 'token'));
  await assert.rejects(client.automation('getRows', { spreadsheet_id: 'https://example.test', range: 'Sheet1!A1:C2' }, 'token'));
  const failing = load('src/app/services/googleSheetsClient.service.ts', { axios: es({ request: async () => { throw { config: { secret: 'must-never-leak' } }; } }), '../utils/googleSheets': { fail: utils.fail } });
  await assert.rejects(new failing.GoogleSheetsClient().automation('createSpreadsheet', { title: 'Test' }, 'secret-token'), error => !error.message.includes('must-never-leak') && error.statusCode === 502);
});

test('Shopify app credentials use the fixed token endpoint and form grant without leaking provider errors', async () => {
  const calls = []; let rejected = false;
  const shopify = load('src/app/utils/shopify.ts', errors);
  const { ShopifyClient } = load('src/app/services/shopifyClient.service.ts', {
    '../utils/shopify': shopify, axios: { __esModule: true, default: { post: async (url, body, config) => {
      calls.push({ url, body, config });
      if (rejected) throw { response: { status: 400, data: { error: 'shop_not_permitted', secret: 'private-customer-secret' } } };
      return { data: { access_token: 'private-token', expires_in: 86399 } };
    } } },
  });
  const client = new ShopifyClient();
  assert.equal((await client.clientCredentials('owned.myshopify.com', 'app-client', 'private-customer-secret')).expires_in, 86399);
  assert.equal(calls[0].url, 'https://owned.myshopify.com/admin/oauth/access_token');
  assert.equal(calls[0].config.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(calls[0].body).get('grant_type'), 'client_credentials');
  assert.equal(calls[0].config.maxRedirects, 0);
  await assert.rejects(client.clientCredentials('https://evil.example', 'app', 'secret'), error => error.statusCode === 400);
  assert.equal(calls.length, 1);
  rejected = true;
  await assert.rejects(client.clientCredentials('owned.myshopify.com', 'app-client', 'private-customer-secret'), error => error.statusCode === 403 && !error.message.includes('private-customer-secret'));
});

test('separate automation flows: PostgreSQL, authenticated HTTP, signed receipts and durable workers', { skip: !process.env.AUTOMATION_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.AUTOMATION_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.ok(url.pathname.includes('automation_test'), 'Only use a fresh disposable automation_test database');
  const db = knex({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 6 } });
  const ids = Object.fromEntries(['company', 'otherCompany', 'owner', 'peer', 'outsider', 'member', 'shop', 'otherShop', 'google'].map(name => [name, crypto.randomUUID()]));
  const scope = { userId: ids.owner, companyId: ids.company };
  const ownerScope = { ...scope, ownerId: ids.owner };
  const config = { AUTOMATION_PUBLIC_BASE_URL: 'https://api.example.test', AUTOMATION_ENCRYPTION_KEY: key, JWT_SECRET: crypto.randomBytes(32).toString('hex'), WORKER_MODE: 'true', SHOPIFY_TOKEN_ENCRYPTION_KEY: key, SHOPIFY_CLIENT_ID: 'test-client', SHOPIFY_CLIENT_SECRET: 'test-client-secret-automation-1234', SHOPIFY_REDIRECT_URI: 'https://api.example.test/v1/integrations/shopify/callback' };
  const prior = Object.fromEntries(Object.keys(config).map(name => [name, process.env[name]]));
  Object.assign(process.env, config);
  const migration = load('src/database/migrations/20261022000002_automation_flows.ts');
  const appMigration = load('src/database/migrations/20261022000003_shopify_client_credentials.ts');
  let migrated = false, appsMigrated = false, server, flow, razorConnection;
  try {
    await db.schema.createTable('companies', table => { table.uuid('id').primary(); table.text('status'); table.timestamp('deleted_at'); });
    await db.schema.createTable('users', table => { table.uuid('id').primary(); table.uuid('company_id'); table.enu('role', ['user', 'admin', 'superadmin', 'member', 'viewer'], { useNative: true, enumName: 'role_enum' }); table.text('status'); table.timestamp('deleted_at'); });
    await db('companies').insert([{ id: ids.company, status: 'active' }, { id: ids.otherCompany, status: 'active' }]);
    await db('users').insert(['owner', 'peer', 'outsider', 'member'].map(name => ({ id: ids[name], company_id: name === 'outsider' ? ids.otherCompany : ids.company, role: name === 'member' ? 'member' : 'user', status: 'active' })));
    await db.schema.createTable('shopify_connections', table => {
      table.uuid('id').primary(); table.uuid('company_id'); table.uuid('owner_id'); table.text('name'); table.text('shop_domain'); table.text('status'); table.jsonb('scopes'); table.text('access_token_ciphertext'); table.text('refresh_token_ciphertext'); table.timestamp('token_expires_at'); table.timestamp('refresh_expires_at'); table.timestamp('updated_at'); table.timestamp('created_at');
      table.unique('shop_domain'); table.text('shop_id'); table.jsonb('desired_topics'); table.text('delivery_token_ciphertext'); table.text('subscription_issue'); table.timestamp('connected_at');
    });
    await db.schema.createTable('google_sheet_connections', table => { table.uuid('id').primary(); table.uuid('company_id'); table.uuid('owner_id'); table.timestamp('created_at'); });
    const shopifyUtils = load('src/app/utils/shopify.ts', errors);
    await db('shopify_connections').insert([{ id: ids.shop, company_id: ids.company, owner_id: ids.owner, name: 'Store', shop_domain: 'owned.myshopify.com', status: 'connected', scopes: JSON.stringify(['read_orders', 'read_products']), access_token_ciphertext: shopifyUtils.encrypt('private-shopify-token', `${ids.company}:${ids.owner}:owned.myshopify.com`), token_expires_at: new Date(Date.now() + 3600000) }, { id: ids.otherShop, company_id: ids.company, owner_id: ids.peer, name: 'Peer store', shop_domain: 'peer.myshopify.com', status: 'connected', scopes: '[]' }]);
    await db('google_sheet_connections').insert({ id: ids.google, company_id: ids.company, owner_id: ids.owner });
    await migration.up(db); migrated = true;
    await appMigration.up(db); appsMigrated = true;
    const subscriptions = [], subscriptionCalls = { create: 0, remove: 0, refresh: 0, clientTokens: 0 };
    let subscriptionFailure = false;
    const { ShopifyService: SubscriptionService } = load('src/app/services/shopify.service.ts', {
      '@surefy/database': db, './shopifyClient.service': { ShopifyClient: class {} },
      '../utils/shopifyMessaging': { enqueueShopifyMessage() {} }, '../utils/shopify': shopifyUtils,
    });
    const webhookProvider = new SubscriptionService(db, {
      clientCredentials: async () => { subscriptionCalls.clientTokens++; return { access_token: 'own-app-access', expires_in: 86399 }; },
      identity: async shop => ({ shop: { id: 'gid://shopify/Shop/9876', myshopifyDomain: shop }, currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }] } }),
      refresh: async () => { subscriptionCalls.refresh++; return { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, refresh_token_expires_in: 86400 }; },
      subscriptions: async () => { if (subscriptionFailure) throw new CustomError('Provider temporarily unavailable', 502); return structuredClone(subscriptions); },
      subscribe: async (_shop, _token, topic, uri) => { subscriptionCalls.create++; const row = { id: 'gid://shopify/WebhookSubscription/' + crypto.randomUUID(), topic, uri }; subscriptions.push(row); return row; },
      unsubscribe: async (_shop, _token, id) => { subscriptionCalls.remove++; const index = subscriptions.findIndex(s => s.id === id); if (index >= 0) subscriptions.splice(index, 1); },
    });
    const { AutomationFlowService } = load('src/app/services/automationFlow.service.ts', { '@surefy/database': db, '../utils/automationFlow': utils, '../utils/automationTemplate': automationTemplates, '../utils/shopify': shopifyUtils });
    const service = new AutomationFlowService(db, webhookProvider);
    const helpers = { tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next), successResponse: (_req, res, message, data, status = 200) => res.status(status).json({ success: true, message, data }) };
    const controller = load('src/app/http/controllers/automationFlow.controller.ts', { '@surefy/utils/Controller': helpers, '../../services/automationFlow.service': es(service) });
    const privateRoute = load('src/routes/automationFlow.route.ts', { '../app/http/controllers/automationFlow.controller': controller }).default;
    const publicRoute = load('src/routes/automationFlowPublic.route.ts', { '../app/http/controllers/automationFlow.controller': controller }).default;
    const auth = load('library/surefy/src/middleware/jwtAuth.middleware.ts', { ...errors, '../database': db, '../utils/facebookReviewSession': { facebookReviewSecret: key => key + '-review', facebookReviewPurpose: 'review' } });
    const secured = express.Router(); secured.use(auth.jwtAuthMiddleware, privateRoute);
    const base = load('library/surefy/src/server.ts', { './middleware/errorHandler': { errorHandler: (error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ success: false, message: error.message }) }, './exceptions/CustomError': { CustomError }, './routes/health.route': es(express.Router()), './middleware/upload.middleware': { UPLOADS_DIR: '/nonexistent-automation-fixture' } }).default;
    const app = base([{ basePath: '/v1/admin/flows', route: secured }, { basePath: '/v1/webhook', route: publicRoute }]);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function api(who, route, body, method = body ? 'POST' : 'GET') {
      const token = jwt.sign({ userId: ids[who], companyId: ids.otherCompany, ownerId: ids.owner, role: 'admin' }, config.JWT_SECRET, { expiresIn: '10m' });
      const response = await fetch(origin + '/v1/admin/flows' + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, ...(await response.json()) };
    }
    async function hook(payload, options = {}) {
      const raw = options.raw || JSON.stringify(payload), provider = options.provider || 'shopify';
      const signature = crypto.createHmac('sha256', options.signingSecret || signingSecret).update(raw).digest(provider === 'shopify' ? 'base64' : 'hex');
      const headers = { 'Content-Type': 'application/json', ...(provider === 'shopify' ? { 'X-Shopify-Hmac-Sha256': signature, 'X-Shopify-Shop-Domain': 'owned.myshopify.com', 'X-Shopify-Topic': 'orders/create', 'X-Shopify-Event-Id': options.eventId || crypto.randomUUID() } : { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': options.eventId || crypto.randomUUID() }), ...options.headers };
      const target = options.flow || flow;
      const response = await fetch(origin + new URL(target.webhookPath).pathname, { method: 'POST', headers, body: raw });
      return { status: response.status, ...(await response.json()) };
    }
    const writes = [];
    const { AutomationRunner } = load('src/app/services/automationRunner.service.ts', { './automationFlow.service': { AutomationFlowService }, './automationProvider.service': { AutomationProvider: class {} }, '../utils/automationFlow': utils });
    const runner = () => new AutomationRunner(service, { execute: async (_scope, step, parameters) => { writes.push({ step, parameters }); return step.key === 'createSpreadsheet' ? { spreadsheetId: 'created_spreadsheet_123', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/created_spreadsheet_123' } : { updatedRows: parameters.values.length }; } });

    await t.test('flow creation attaches real ownership and returns an empty draft and a per-flow webhook', async () => {
      const anonymous = await fetch(origin + '/v1/admin/flows'); assert.equal(anonymous.status, 401);
      const created = await api('owner', '', { name: 'Shopify order to Sheets', user_id: ids.peer, company_id: ids.otherCompany });
      assert.equal(created.status, 201); flow = created.data;
      assert.equal(flow.user_id, ids.owner); assert.equal(flow.company_id, ids.company);
      assert.deepEqual(flow.steps, []);
      assert.deepEqual((await api('owner', '/' + flow.id)).data.steps, []);
      assert.equal((await api('owner', '/' + flow.id + '/status', { status: 'active' }, 'PATCH')).status, 400);
      assert.equal((await api('owner', '/' + flow.id + '/webhook', { signing_secret: signingSecret })).status, 400);
      assert.ok(flow.webhookPath.startsWith('https://api.example.test/v1/webhook/flows/'));
      assert.equal((await api('member', '', { name: 'Impersonation' })).status, 403);
      assert.equal((await api('peer', '/' + flow.id)).status, 404);
      assert.equal((await api('outsider', '/' + flow.id)).status, 404);
      assert.equal((await api('owner', '/apps')).data.length, 4);
      assert.equal(JSON.stringify(await api('owner', '/connections')).includes('private-shopify-token'), false);
    });

    await t.test('nodes are added explicitly, deletion repairs links and removing a trigger disables its webhook', async () => {
      let draft = (await api('owner', '', { name: 'Node editing validation' })).data;
      const path = '/' + draft.id;
      draft = (await api('owner', path + '/steps', { type: 'trigger', appKey: 'shopify', key: 'new_order', connectionId: ids.shop })).data;
      assert.equal(draft.steps.length, 1); assert.equal(draft.steps[0].nextStepId, null);
      assert.equal((await api('owner', path + '/steps', { type: 'trigger' })).status, 409);
      assert.equal((await api('owner', path + '/steps', { type: 'invalid' })).status, 400);
      for (let n = 0; n < 3; n++) draft = (await api('owner', path + '/steps', { type: 'action', appKey: 'google-sheets', key: 'createSpreadsheet', connectionId: ids.google, parameters: { title: 'Sheet ' + n } })).data;
      const [trigger, first, middle, last] = draft.steps;
      assert.equal((await api('peer', path + '/steps/' + middle._id, undefined, 'DELETE')).status, 404);
      assert.equal((await api('owner', path + '/steps/' + middle._id, { revision: 1 }, 'DELETE')).status, 409);
      draft = (await api('owner', path + '/steps/' + middle._id, { revision: draft.revision }, 'DELETE')).data;
      assert.deepEqual(draft.steps.map(s => s._id), [trigger._id, first._id, last._id]);
      assert.equal(draft.steps[1].nextStepId, last._id); assert.equal(draft.steps[2].nextStepId, null);
      assert.equal((await api('owner', path + '/steps/' + middle._id, undefined, 'DELETE')).status, 404);
      await api('owner', path + '/webhook', { signing_secret: signingSecret });
      draft = (await api('owner', path + '/status', { status: 'active' }, 'PATCH')).data;
      assert.equal((await api('owner', path + '/steps/' + trigger._id, undefined, 'DELETE')).status, 409);
      await api('owner', path + '/status', { status: 'inactive' }, 'PATCH');
      draft = (await api('owner', path + '/steps/' + trigger._id, undefined, 'DELETE')).data;
      assert.deepEqual(draft.steps.map(s => s._id), [first._id, last._id]); assert.equal(draft.webhookConfigured, false);
      assert.equal((await hook({ id: 22 }, { flow: draft })).status, 404);
      assert.equal((await api('owner', path + '/status', { status: 'active' }, 'PATCH')).status, 400);
      assert.equal((await api('owner', path + '/webhook', { signing_secret: signingSecret })).status, 400);
      draft = (await api('owner', path + '/steps', { type: 'trigger', appKey: 'shopify', key: 'new_order', connectionId: ids.shop })).data;
      assert.equal(draft.steps[0].type, 'trigger'); assert.equal(draft.steps[0].nextStepId, first._id);
      assert.equal(draft.webhookConfigured, false);
      for (const step of [...draft.steps]) draft = (await api('owner', path + '/steps/' + step._id, undefined, 'DELETE')).data;
      assert.deepEqual(draft.steps, []); assert.deepEqual((await api('owner', path)).data.steps, []);
      assert.equal((await api('owner', path + '/steps/' + crypto.randomUUID(), undefined, 'DELETE')).status, 404);
      draft = (await api('owner', path + '/steps', {})).data;
      assert.equal(draft.steps.length, 1); assert.equal(draft.steps[0].type, 'trigger');
      draft = (await api('owner', path + '/steps', { steps: [] }, 'PUT')).data;
      assert.deepEqual(draft.steps, []);
      await api('owner', path, undefined, 'DELETE');
    });

    await t.test('Cart update captures repeated test payloads with new event IDs and deduplicates delivery retries', async () => {
      const catalog = await api('owner', '/apps');
      assert.equal(catalog.data.find(app => app.appKey === 'shopify').triggers.find(item => item.key === 'updated_cart').topic, 'carts/update');
      let draft = (await api('owner', '', { name: 'Cart update capture' })).data;
      draft = (await api('owner', '/' + draft.id + '/steps', { type: 'trigger', appKey: 'shopify', key: 'updated_cart', connectionId: ids.shop })).data;
      const configured = await api('owner', '/' + draft.id + '/webhook', { signing_secret: signingSecret });
      assert.equal(configured.status, 200); assert.equal(configured.data.topic, 'carts/update');
      const headers = { 'X-Shopify-Topic': 'carts/update' }, payload = { id: 'test-cart', token: 'same-sample-payload', line_items: [] };
      const eventId = crypto.randomUUID();
      const first = await hook(payload, { flow: draft, headers, eventId });
      const second = await hook(payload, { flow: draft, headers });
      assert.equal(first.status, 200); assert.equal(first.data.mode, 'capture_only');
      assert.equal(second.status, 200); assert.equal(second.data.duplicate, false);
      assert.notEqual(first.data.event_id, second.data.event_id);
      const retry = await hook(payload, { flow: draft, headers, eventId });
      assert.equal(retry.status, 200); assert.equal(retry.data.duplicate, true);
      const events = (await api('owner', '/' + draft.id + '/events')).data;
      assert.equal(events.length, 2); assert.equal(events.every(event => event.topic === 'carts/update'), true);
      assert.equal((await api('owner', '/' + draft.id + '/runs')).data.length, 0);
      const wrongTopic = await hook(payload, { flow: draft, headers: { 'X-Shopify-Topic': 'orders/updated' } });
      assert.equal(wrongTopic.data.reason, 'topic_not_configured');
      assert.equal((await api('owner', '/' + draft.id + '/events')).data.length, 2);
      await api('owner', '/' + draft.id, undefined, 'DELETE');
    });

    await t.test('customer app credentials create a scoped encrypted connection and one flow webhook for multiple actions', async () => {
      const clientSecret = 'customer-app-client-secret-1234567890';
      const body = { appKey: 'shopify', name: 'My own app', shop: 'own-app.myshopify.com', client_id: 'customer-app-client', client_secret: clientSecret };
      assert.equal((await api('owner', '/connections', { ...body, owner_id: ids.peer })).status, 400);
      assert.equal((await api('owner', '/connections', { ...body, shop: 'https://evil.example' })).status, 400);
      const created = await api('owner', '/connections', body);
      assert.equal(created.status, 201); assert.equal(created.data.authentication, 'client_credentials');
      assert.equal(created.data.credentials_configured, true); assert.equal(created.data.client_secret, undefined);
      assert.equal(JSON.stringify(created).includes(clientSecret), false);
      assert.equal(JSON.stringify(created).includes('own-app-access'), false);
      const connection = created.data;
      const privateApp = await db('shopify_app_credentials').where({ connection_id: connection.id }).first();
      assert.equal(privateApp.client_secret_ciphertext.includes(clientSecret), false);
      const ctx = `${ids.company}:${ids.owner}:own-app.myshopify.com`;
      assert.equal(shopifyUtils.decrypt(privateApp.client_secret_ciphertext, `${ctx}:client:customer-app-client`), clientSecret);
      const callsBeforeForeign = subscriptionCalls.clientTokens;
      assert.equal((await api('peer', '/connections', body)).status, 409);
      assert.equal(subscriptionCalls.clientTokens, callsBeforeForeign);
      const repeated = await api('owner', '/connections', body);
      assert.equal(repeated.data.id, connection.id);
      assert.equal((await api('owner', '/connections', { ...body, shop: 'owned.myshopify.com' })).status, 409);
      const listed = (await api('owner', '/connections')).data.find(c => c.id === connection.id);
      assert.equal(listed.authentication, 'client_credentials'); assert.equal(JSON.stringify(listed).includes(clientSecret), false);
      let draft = (await api('owner', '', { name: 'Own app order to actions' })).data;
      const path = '/' + draft.id;
      draft = (await api('owner', path + '/steps', { type: 'trigger', appKey: 'shopify', key: 'new_order', connectionId: connection.id })).data;
      const first = await api('owner', path + '/webhook/subscribe', {});
      assert.equal(first.status, 200); assert.equal(first.data.subscribed, true);
      const createCount = subscriptionCalls.create;
      for (let n = 0; n < 2; n++) draft = (await api('owner', path + '/steps', { type: 'action', appKey: 'google-sheets', key: 'createSpreadsheet', connectionId: ids.google, parameters: { title: 'Action ' + n } })).data;
      assert.equal((await api('owner', path + '/webhook/subscribe', {})).data.reused, true);
      assert.equal(subscriptionCalls.create, createCount);
      assert.equal(subscriptions.filter(s => s.uri.includes(draft.id)).length, 1);
      const captured = await hook({ id: 77 }, { flow: draft, signingSecret: clientSecret, headers: { 'X-Shopify-Shop-Domain': 'own-app.myshopify.com' } });
      assert.equal(captured.status, 200); assert.equal(captured.data.mode, 'capture_only');
      assert.equal((await hook({ id: 78 }, { flow: draft, signingSecret: config.SHOPIFY_CLIENT_SECRET, headers: { 'X-Shopify-Shop-Domain': 'own-app.myshopify.com' } })).status, 401);
      await db('shopify_connections').where({ id: connection.id }).update({ token_expires_at: new Date(0) });
      const beforeRefresh = subscriptionCalls.clientTokens;
      const statuses = await Promise.all([api('owner', path + '/webhook/status'), api('owner', path + '/webhook/status')]);
      assert.equal(statuses.every(result => result.status === 200 && result.data.ready), true);
      assert.equal(subscriptionCalls.clientTokens, beforeRefresh + 1);
      assert.equal((await db('shopify_connections').where({ id: connection.id }).first()).refresh_token_ciphertext, null);
      await api('owner', path + '/webhook/subscription', {}, 'DELETE');
      await api('owner', path, undefined, 'DELETE');
    });

    await t.test('automatic Shopify setup registers a scoped app-signed webhook without accepting or exposing customer secrets', async () => {
      let draft = (await api('owner', '', { name: 'Automatic Shopify webhook' })).data;
      const path = '/' + draft.id;
      draft = (await api('owner', path + '/steps', { type: 'trigger', appKey: 'shopify', key: 'updated_cart', connectionId: ids.shop })).data;
      assert.equal((await api('peer', path + '/webhook/subscribe', {})).status, 404);
      assert.equal((await api('owner', path + '/webhook/subscribe', { client_secret: 'must-not-be-accepted' })).status, 400);
      assert.equal((await api('owner', path + '/webhook/subscribe', { revision: 1 })).status, 409);
      let configured = await api('owner', path + '/webhook/subscribe', { revision: draft.revision });
      assert.equal(configured.status, 200); assert.equal(configured.data.subscribed, true);
      assert.equal(configured.data.authentication, 'shopify_app'); assert.equal(configured.data.topic, 'carts/update');
      assert.equal(JSON.stringify(configured).includes(config.SHOPIFY_CLIENT_SECRET), false);
      assert.equal(JSON.stringify(configured).includes('private-shopify-token'), false);
      const privateRow = await db('automation_flows').where({ id: draft.id }).first();
      assert.equal(utils.decrypt(privateRow.webhook_secret_ciphertext, 'webhook:' + draft.id), config.SHOPIFY_CLIENT_SECRET);
      let status = await api('owner', path + '/webhook/status');
      assert.equal(status.data.ready, true); assert.equal(status.data.authentication, 'shopify_app');
      const creationCount = subscriptionCalls.create;
      configured = await api('owner', path + '/webhook/subscribe', { revision: configured.data.revision });
      assert.equal(configured.data.reused, true); assert.equal(subscriptionCalls.create, creationCount);
      const headers = { 'X-Shopify-Topic': 'carts/update' };
      assert.equal((await hook({ id: 'sample-cart' }, { flow: draft, headers })).status, 401);
      const received = await hook({ id: 'sample-cart' }, { flow: draft, headers, signingSecret: config.SHOPIFY_CLIENT_SECRET });
      assert.equal(received.status, 200); assert.equal(received.data.mode, 'capture_only');
      const uri = configured.data.webhookPath;
      subscriptions.push({ id: 'duplicate', topic: 'CARTS_UPDATE', uri },
        { id: 'obsolete-host', topic: 'CARTS_UPDATE', uri: uri.replace('api.example.test', 'old.example.test') },
        { id: 'other-flow', topic: 'ORDERS_CREATE', uri: uri.replace(draft.id, crypto.randomUUID()) });
      configured = await api('owner', path + '/webhook/subscribe', {});
      assert.equal(subscriptions.length, 2); assert.equal(subscriptions.some(s => s.id === 'other-flow'), true);
      draft = (await api('owner', path + '/steps/' + draft.steps[0]._id, { key: 'updated_order' }, 'PATCH')).data;
      assert.equal(draft.webhookConfigured, false);
      configured = await api('owner', path + '/webhook/subscribe', { revision: draft.revision });
      assert.equal(configured.data.topic, 'orders/updated');
      assert.equal(subscriptions.filter(s => s.uri === uri).length, 1);
      assert.equal(subscriptions.find(s => s.uri === uri).topic, 'ORDERS_UPDATED');
      const removed = await api('owner', path + '/webhook/subscription', { revision: configured.data.revision }, 'DELETE');
      assert.equal(removed.status, 200); assert.equal(removed.data.removed, 1);
      status = await api('owner', path + '/webhook/status');
      assert.equal(status.data.subscribed, false); assert.equal(status.data.signing_secret_configured, false);
      assert.equal(subscriptions.length, 1); assert.equal(subscriptions[0].id, 'other-flow');
      subscriptions.length = 0;
      await api('owner', path, undefined, 'DELETE');
    });

    await t.test('automatic webhook retries preserve rotated credentials after provider failure and enforce scopes and ownership', async () => {
      const ctx = `${ids.company}:${ids.owner}:owned.myshopify.com`;
      await db('shopify_connections').where({ id: ids.shop }).update({ token_expires_at: new Date(0),
        refresh_expires_at: new Date(Date.now() + 86400000), refresh_token_ciphertext: shopifyUtils.encrypt('initial-refresh', ctx) });
      let draft = (await api('owner', '', { name: 'Automatic setup retry' })).data;
      const path = '/' + draft.id;
      draft = (await api('owner', path + '/steps', { type: 'trigger', appKey: 'shopify', key: 'new_order', connectionId: ids.shop })).data;
      subscriptionFailure = true;
      const failed = await api('owner', path + '/webhook/subscribe', {});
      assert.equal(failed.status, 502); assert.equal(subscriptionCalls.refresh, 1);
      const connection = await db('shopify_connections').where({ id: ids.shop }).first();
      assert.equal(shopifyUtils.decrypt(connection.refresh_token_ciphertext, ctx), 'rotated-refresh');
      subscriptionFailure = false;
      const retried = await api('owner', path + '/webhook/subscribe', {});
      assert.equal(retried.status, 200); assert.equal(subscriptionCalls.refresh, 1);
      await api('owner', path + '/webhook/subscription', {}, 'DELETE');
      draft = (await api('owner', path + '/steps/' + draft.steps[0]._id, { connectionId: ids.otherShop }, 'PATCH')).data;
      assert.equal((await api('owner', path + '/webhook/subscribe', {})).status, 404);
      draft = (await api('owner', path + '/steps/' + draft.steps[0]._id, { connectionId: ids.shop, key: 'new_customer' }, 'PATCH')).data;
      assert.equal((await api('owner', path + '/webhook/subscribe', {})).status, 403);
      assert.equal(subscriptions.length, 0);
      await api('owner', path, undefined, 'DELETE');
    });

    await t.test('configuration validates revisions and activation; draft flows capture signed samples without executing', async () => {
      const saved = await api('owner', '/' + flow.id + '/steps', { revision: flow.revision, steps: [
        { type: 'trigger', appKey: 'shopify', key: 'new_order', connectionId: ids.shop },
        { type: 'action', appKey: 'google-sheets', key: 'createSpreadsheet', connectionId: ids.google, parameters: { title: 'Order {{trigger.name}}' } },
      ] }, 'PUT');
      assert.equal(saved.status, 200); flow = saved.data;
      assert.equal((await api('owner', '/' + flow.id + '/steps', { revision: 1, steps: flow.steps }, 'PUT')).status, 409);
      assert.equal((await api('owner', '/' + flow.id + '/status', { status: 'active' }, 'PATCH')).status, 400);
      assert.equal((await api('owner', '/' + flow.id + '/webhook', { signing_secret: signingSecret })).status, 200);
      flow = (await api('owner', '/' + flow.id)).data;
      const received = await hook({ id: 1001, name: '#1001' }, { raw: '{ "id": 1001, "name": "#1001" }' });
      assert.equal(received.status, 200); assert.equal(received.data.mode, 'capture_only');
      assert.equal((await api('owner', '/' + flow.id + '/runs')).data.length, 0);
      const sample = await api('owner', '/' + flow.id + '/events/' + received.data.event_id);
      assert.equal(sample.data.payload.name, '#1001');
      assert.equal((await api('peer', '/' + flow.id + '/events/' + received.data.event_id)).status, 404);
    });

    await t.test('forged signatures, mismatched stores and unrelated topics never queue actions', async () => {
      assert.equal((await hook({ id: 1002 }, { headers: { 'X-Shopify-Hmac-Sha256': 'invalid' } })).status, 401);
      assert.equal((await hook({ id: 1002 }, { headers: { 'X-Shopify-Shop-Domain': 'peer.myshopify.com' } })).status, 403);
      const ignored = await hook({ id: 1002 }, { headers: { 'X-Shopify-Topic': 'orders/paid' } });
      assert.equal(ignored.data.ignored, true);
      const tooLarge = await hook({}, { raw: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }) });
      assert.equal(tooLarge.status, 413);
      assert.equal((await api('owner', '/' + flow.id + '/runs')).data.length, 0);
    });

    await t.test('signed Shopify receipts retain original phone fields and expose scoped contact data usable by actions', async () => {
      let draft = (await api('owner', '', { name: 'Order phone capture' })).data;
      const path = '/' + draft.id;
      draft = (await api('owner', path + '/steps', { type: 'trigger', appKey: 'shopify', key: 'new_order', connectionId: ids.shop })).data;
      draft = (await api('owner', path + '/steps', { type: 'action', appKey: 'google-sheets', key: 'createSpreadsheet', connectionId: ids.google, parameters: { title: 'Buyer {{contact.phone}}' } })).data;
      await api('owner', path + '/webhook', { signing_secret: signingSecret });
      const payload = { id: 4099, phone: null, customer: { phone: '+12025550123' }, shipping_address: { phone: '+442079460019' } };
      const captured = await hook(payload, { flow: draft }); assert.equal(captured.status, 200);
      const detail = await api('owner', path + '/events/' + captured.data.event_id);
      assert.deepEqual(detail.data.payload, payload); assert.equal(detail.data.contact.phone, payload.customer.phone);
      assert.equal(detail.data.contact.phone_source, 'customer.phone'); assert.equal(detail.data.contact.shipping_phone, payload.shipping_address.phone);
      const encrypted = await db('automation_events').where({ id: captured.data.event_id }).first('payload_ciphertext');
      assert.equal(encrypted.payload_ciphertext.includes(payload.customer.phone), false);
      assert.equal((await api('peer', path + '/events/' + captured.data.event_id)).status, 404);
      const queued = await api('owner', path + '/test-runs', { event_id: captured.data.event_id, request_id: crypto.randomUUID() });
      await runner().processNext();
      const run = await api('owner', path + '/runs/' + queued.data.id);
      assert.equal(run.data.status, 'succeeded'); assert.equal(writes.at(-1).parameters.title, 'Buyer +12025550123');
      const empty = await hook({ id: 4100 }, { flow: draft });
      assert.equal((await api('owner', path + '/events/' + empty.data.event_id)).data.contact.phone_status, 'missing');
      const delivery = await hook({ id: 4101, shipping_address: payload.shipping_address }, { flow: draft });
      const deliveryDetail = (await api('owner', path + '/events/' + delivery.data.event_id)).data;
      assert.equal(deliveryDetail.contact.phone, null); assert.equal(deliveryDetail.contact.shipping_phone, payload.shipping_address.phone);
      await api('owner', path, undefined, 'DELETE');
      writes.length = 0;
    });

    await t.test('activation enforces account-owned connections and concurrent webhook retries create one run', async () => {
      const original = flow.steps;
      let saved = await api('owner', '/' + flow.id + '/steps', { steps: [{ ...original[0], connectionId: ids.otherShop }, original[1]] }, 'PUT');
      assert.equal(saved.status, 200);
      assert.equal((await api('owner', '/' + flow.id + '/webhook', { signing_secret: signingSecret })).status, 404);
      await api('owner', '/' + flow.id + '/steps', { steps: original }, 'PUT');
      await api('owner', '/' + flow.id + '/webhook', { signing_secret: signingSecret });
      const active = await api('owner', '/' + flow.id + '/status', { status: 'active' }, 'PATCH'); assert.equal(active.status, 200); flow = active.data;
      assert.equal((await api('owner', '/' + flow.id + '/steps', { steps: original }, 'PUT')).status, 409);
      const eventId = crypto.randomUUID();
      const replies = await Promise.all([hook({ id: 1003, name: '#1003' }, { eventId }), hook({ id: 1003, name: '#1003' }, { eventId })]);
      assert.deepEqual(replies.map(reply => !!reply.data.duplicate).sort(), [false, true]);
      assert.equal((await api('owner', '/' + flow.id + '/runs')).data.length, 1);
      await Promise.all([runner().processNext(), runner().processNext()]);
      assert.equal(writes.length, 1); assert.equal(writes[0].parameters.title, 'Order #1003');
      assert.equal((await api('owner', '/' + flow.id + '/runs')).data[0].status, 'succeeded');
    });

    await t.test('ordered actions map previous outputs and explicit test-run retries are idempotent', async () => {
      flow = (await api('owner', '/' + flow.id + '/status', { status: 'inactive' }, 'PATCH')).data;
      flow = (await api('owner', '/' + flow.id + '/steps', { appKey: 'google-sheets', key: 'appendRows', connectionId: ids.google, parameters: { spreadsheet_id: '{{steps.' + flow.steps[1]._id + '.spreadsheetId}}', range: 'Sheet1!A1:B', values: [['{{trigger.name}}', '{{trigger.id}}']] } })).data;
      const sample = (await api('owner', '/' + flow.id + '/events')).data[0];
      const body = { event_id: sample.id, request_id: crypto.randomUUID() };
      const queued = await api('owner', '/' + flow.id + '/test-runs', body);
      assert.equal(queued.status, 202);
      assert.equal((await api('owner', '/' + flow.id + '/test-runs', body)).data.id, queued.data.id);
      await runner().processNext();
      const detail = (await api('owner', '/' + flow.id + '/runs/' + queued.data.id)).data;
      assert.equal(detail.status, 'succeeded'); assert.equal(detail.steps.length, 2);
      assert.equal(writes[writes.length - 1].parameters.spreadsheet_id, 'created_spreadsheet_123');
      assert.equal(typeof writes[writes.length - 1].parameters.values[0][1], 'number');
    });

    await t.test('uncertain provider writes and worker crashes require review instead of automatic duplicate writes', async () => {
      const sample = (await api('owner', '/' + flow.id + '/events')).data[0];
      const queued = await api('owner', '/' + flow.id + '/test-runs', { event_id: sample.id, request_id: crypto.randomUUID() });
      let attempts = 0;
      const uncertain = new AutomationRunner(service, { execute: async () => { attempts++; throw Error('private-provider-error'); } });
      await uncertain.processNext(); await uncertain.processNext();
      const detail = (await api('owner', '/' + flow.id + '/runs/' + queued.data.id)).data;
      assert.equal(detail.status, 'requires_review'); assert.equal(attempts, 1);
      assert.equal(JSON.stringify(detail).includes('private-provider-error'), false);
      await db('automation_runs').where({ id: queued.data.id }).update({ status: 'running', updated_at: new Date(Date.now() - 16 * 60000) });
      await uncertain.recoverStale();
      assert.equal((await api('owner', '/' + flow.id + '/runs/' + queued.data.id)).data.status, 'requires_review');
    });

    await t.test('Razorpay connections keep credentials private and signed payment triggers capture events', async () => {
      const connected = await api('owner', '/connections', { appKey: 'razorpay', name: 'Razorpay test', mode: 'test', key_id: 'rzp_test_isolated', key_secret: 'private-razorpay-secret' });
      assert.equal(connected.status, 201); razorConnection = connected.data;
      assert.equal(JSON.stringify(connected).includes('private-razorpay-secret'), false);
      assert.equal(JSON.stringify(await api('owner', '/connections')).includes('private-razorpay-secret'), false);
      const created = await api('owner', '', { name: 'Paid payment to sheet' }); let paymentFlow = created.data;
      paymentFlow = (await api('owner', '/' + paymentFlow.id + '/steps', { steps: [{ type: 'trigger', appKey: 'razorpay', key: 'payment_captured', connectionId: razorConnection.id }, { type: 'action', appKey: 'google-sheets', key: 'createSpreadsheet', connectionId: ids.google, parameters: { title: 'Payment received' } }] }, 'PUT')).data;
      await api('owner', '/' + paymentFlow.id + '/webhook', { signing_secret: signingSecret });
      const received = await hook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_test', amount: 500 } } } }, { flow: paymentFlow, provider: 'razorpay' });
      assert.equal(received.status, 200); assert.equal(received.data.mode, 'capture_only');
      const calls = [];
      const { AutomationProvider } = load('src/app/services/automationProvider.service.ts', { axios: es({ request: async request => { calls.push(request); return { data: { id: 'plink_test123', ...request.data, status: 'created', short_url: 'https://rzp.io/i/test' } }; } }), './automationFlow.service': { AutomationFlowService }, '../utils/automationFlow': utils });
      const output = await new AutomationProvider(service).execute(scope, { appKey: 'razorpay', key: 'createPaymentLink', connectionId: razorConnection.id, _id: crypto.randomUUID() }, { amount_paise: 500, description: 'Test link' }, crypto.randomUUID());
      assert.equal(calls[0].baseURL, 'https://api.razorpay.com/v1'); assert.equal(calls[0].data.notify.sms, false);
      assert.equal(output.mode, 'test'); assert.equal(JSON.stringify(output).includes('private-razorpay-secret'), false);
    });

    await t.test('Shopify order/product actions use scoped tokens, fixed GraphQL queries and scope checks', async () => {
      const queries = [];
      const { ShopifyService } = load('src/app/services/shopify.service.ts', { '@surefy/database': db, './shopifyClient.service': { ShopifyClient: class {} }, '../utils/shopifyMessaging': { enqueueShopifyMessage() {} }, '../utils/shopify': shopifyUtils });
      const shopify = new ShopifyService(db, { graphql: async (shop, token, query, variables) => { queries.push({ shop, token, query, variables }); return { order: { id: variables.id, name: '#1001' }, products: { nodes: [], pageInfo: { hasNextPage: false } } }; } });
      assert.equal((await shopify.automation(ownerScope, ids.shop, 'getOrder', { order_id: '1001' })).name, '#1001');
      assert.equal(queries[0].variables.id, 'gid://shopify/Order/1001');
      await shopify.automation(ownerScope, ids.shop, 'listProducts', { limit: 10 });
      assert.equal(queries[1].variables.first, 10);
      await assert.rejects(shopify.automation(ownerScope, ids.otherShop, 'getOrder', { order_id: '1001' }), error => error.statusCode === 404);
      await assert.rejects(shopify.automation(ownerScope, ids.shop, 'getOrder', { order_id: 'https://evil.example' }), error => error.statusCode === 400);
      await db('shopify_connections').where({ id: ids.shop }).update({ scopes: JSON.stringify(['read_orders']) });
      await assert.rejects(shopify.automation(ownerScope, ids.shop, 'listProducts', {}), error => error.statusCode === 403);
    });

    await t.test('customer erasure tombstones block capture and expiry removes receipts and dependent runs', async () => {
      await db.schema.createTable('shopify_redactions', table => { table.uuid('connection_id'); table.text('subject_hash'); table.timestamp('expires_at'); });
      const payload = { id: 2007, customer: { id: 42 } };
      const hashes = shopifyUtils.subjectHashes('orders/create', payload, `${ids.company}:${ids.owner}:owned.myshopify.com`);
      await db('shopify_redactions').insert(hashes.map(hash => ({ connection_id: ids.shop, subject_hash: hash, expires_at: new Date(Date.now() + 86400000) })));
      const received = await hook(payload);
      assert.equal(received.data.reason, 'customer_erased');
      const sample = (await api('owner', '/' + flow.id + '/events')).data[0];
      await db('automation_events').where({ id: sample.id }).update({ expires_at: new Date(Date.now() - 1000) });
      assert.equal((await api('owner', '/' + flow.id + '/events/' + sample.id)).status, 404);
      await runner().recoverStale();
      assert.equal((await db('automation_events').where({ id: sample.id })).length, 0);
      assert.equal((await db('automation_runs').where({ event_id: sample.id })).length, 0);
    });

    await t.test('disabled accounts, rotated webhook destinations and deleted flows cannot enqueue work', async () => {
      await db('users').where({ id: ids.owner }).update({ status: 'suspended' });
      assert.equal((await hook({ id: 1005 })).status, 403);
      assert.equal((await api('owner', '/' + flow.id)).status, 401);
      await db('users').where({ id: ids.owner }).update({ status: 'active' });
      const old = flow.webhookPath;
      const rotated = await api('owner', '/' + flow.id + '/webhook', { signing_secret: signingSecret, rotate_token: true });
      assert.equal(rotated.status, 200); assert.notEqual(rotated.data.webhookPath, old);
      assert.equal((await hook({ id: 1006 })).status, 404);
      flow = (await api('owner', '/' + flow.id)).data;
      assert.equal((await api('owner', '/' + flow.id, undefined, 'DELETE')).status, 200);
      assert.equal((await hook({ id: 1007 })).status, 404);
      assert.equal((await api('owner', '/' + flow.id)).status, 404);
    });
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (appsMigrated) await appMigration.down(db);
    if (migrated) await migration.down(db);
    await db.destroy();
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
