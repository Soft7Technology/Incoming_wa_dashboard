require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, memoryDatabase } = require('./shopify-helpers.cjs');
const { CustomError } = require('../library/surefy/src/exceptions/CustomError');
Object.assign(process.env, {
  SHOPIFY_CLIENT_ID: 'test-app-client',
  SHOPIFY_CLIENT_SECRET: 'test-app-secret',
  SHOPIFY_REDIRECT_URI: 'https://api.example.test/v1/integrations/shopify/callback',
  SHOPIFY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString('base64'),
  SHOPIFY_SCOPES: 'read_orders,read_customers',
});
const utils = load('src/app/utils/shopify.ts', { '@surefy/exceptions/CustomError': { CustomError } });
const messagingUtils = load('src/app/utils/shopifyMessaging.ts', {
  './shopify': utils,
  './importPhone': require('../src/app/utils/importPhone'),
  './reminder': require('../src/app/utils/reminder'),
});
const { ShopifyMessagingService } = load('src/app/services/shopifyMessaging.service.ts', {
  '@surefy/database': () => {
    throw Error('Inject isolated database');
  },
  '../utils/shopify': utils,
  '../utils/shopifyMessaging': messagingUtils,
});
const { ShopifyService } = load('src/app/services/shopify.service.ts', {
  '@surefy/database': () => {
    throw Error('Inject isolated database');
  },
  './shopifyClient.service': { ShopifyClient: class {} },
  '../utils/shopify': utils,
  '../utils/shopifyMessaging': messagingUtils,
});
const { ShopifyFlowWebhookService } = load('src/app/services/shopifyFlowWebhook.service.ts', {
  '@surefy/database': {}, './shopify.service': { ShopifyService }, '../utils/shopify': utils,
});
const scope = { companyId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
scope.userId = scope.ownerId;
const other = { ...scope, companyId: crypto.randomUUID() },
  shop = 'my-store.myshopify.com';
const tokens = () => ({
  access_token: 'private-access',
  refresh_token: 'private-refresh',
  expires_in: 3600,
  refresh_token_expires_in: 7776000,
  scope: 'read_orders,read_customers',
});
function fixture() {
  const database = memoryDatabase({
    users: [{ id: scope.ownerId, company_id: scope.companyId, status: 'active' }],
    companies: [{ id: scope.companyId, status: 'active' }],
  });
  const remote = [],
    calls = { exchange: 0, refresh: 0, subscribe: 0, unsubscribe: 0 };
  const client = {
    async exchange() {
      calls.exchange++;
      return tokens();
    },
    async refresh() {
      calls.refresh++;
      return { ...tokens(), access_token: 'new-access', refresh_token: 'new-refresh' };
    },
    async identity() {
      return {
        shop: { id: 'gid://shopify/Shop/123', name: 'My store', myshopifyDomain: shop },
        currentAppInstallation: { accessScopes: ['read_orders', 'read_customers'].map((handle) => ({ handle })) },
      };
    },
    async subscriptions() {
      return structuredClone(remote);
    },
    async subscribe(_shop, _token, topic, uri) {
      calls.subscribe++;
      const record = { id: 'gid://shopify/WebhookSubscription/' + crypto.randomUUID(), topic, uri };
      remote.push(record);
      return record;
    },
    async unsubscribe(_shop, _token, id) {
      calls.unsubscribe++;
      const index = remote.findIndex((s) => s.id === id);
      if (index >= 0) remote.splice(index, 1);
    },
  };
  const sends = [],
    blocked = new Set();
  const messaging = new ShopifyMessagingService(
    database,
    async (data, resolved) => {
      sends.push({ data, resolved });
      await database('messages').insert({
        id: data.messageUUID,
        shopify_job_id: data.shopify_job_id,
        company_id: data.company_id,
        to_phone: data.country_code + data.to,
        content: { template: data.template },
        status: 'sent',
        wamid: 'fixture-wamid',
      });
      return { wamid: 'fixture-wamid' };
    },
    async (_phone, recipient) => blocked.has(recipient),
  );
  return { database, client, remote, calls, service: new ShopifyService(database, client), messaging, sends, blocked };
}
function signedQuery(query) {
  const params = { timestamp: String(Math.floor(Date.now() / 1000)), ...query };
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return {
    ...params,
    hmac: crypto.createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET).update(message).digest('hex'),
  };
}
async function connected(f) {
  const start = await f.service.start(scope, { shop: 'my-store', name: 'My store' });
  const state = new URL(start.authorization_url).searchParams.get('state');
  const query = signedQuery({ shop, state, code: 'one-time-code' });
  const result = await f.service.callback(query, start.browser);
  return { start, query, result, connection: f.database.tables().shopify_connections[0] };
}
function webhook(
  connection,
  payload = { id: 456, customer: { id: 8, phone: '+919999999999' } },
  topic = 'orders/paid',
) {
  const raw = Buffer.from(JSON.stringify(payload));
  return {
    raw,
    signature: crypto.createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET).update(raw).digest('base64'),
    headers: {
      'x-shopify-shop-domain': shop,
      'x-shopify-topic': topic,
      'x-shopify-webhook-id': crypto.randomUUID(),
      'x-shopify-event-id': crypto.randomUUID(),
      'x-shopify-triggered-at': new Date().toISOString(),
    },
    id: connection.id,
    token: utils.decrypt(connection.delivery_token_ciphertext, `${scope.companyId}:${scope.ownerId}:${shop}`),
  };
}
const deliver = (f, w) => f.service.receive(w.raw, w.signature, w.headers, w.id, w.token);

async function privacyDelivery(f, connection, topic, values) {
  const w = webhook(connection, { shop_id: 123, shop_domain: shop, ...values }, topic);
  return f.service.receive(w.raw, w.signature, w.headers);
}

async function enableMessaging(f) {
  const { connection } = await connected(f);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  const wabaId = crypto.randomUUID(),
    phoneId = crypto.randomUUID(),
    templateId = crypto.randomUUID();
  await f.database('waba_accounts').insert({ id: wabaId, company_id: scope.companyId, user_id: scope.ownerId });
  await f
    .database('phone_numbers')
    .insert({
      id: phoneId,
      company_id: scope.companyId,
      user_id: scope.ownerId,
      waba_id: wabaId,
      status: 'active',
      phone_number_id: 'fixture-meta-phone',
      display_phone_number: '+14155550000',
    });
  await f
    .database('templates')
    .insert({
      id: templateId,
      company_id: scope.companyId,
      waba_id: wabaId,
      status: 'APPROVED',
      category: 'UTILITY',
      name: 'order_paid',
      language: 'en_US',
      components: JSON.stringify([{ type: 'BODY', text: 'Order {{1}} is {{2}}.' }]),
    });
  const rule = {
    enabled: true,
    phone_number_id: phoneId,
    template_id: templateId,
    consent_attribute: 'soft7_whatsapp_opt_in',
    consent_confirmed: true,
    parameter_mapping: { 'body.1': { field: 'order_number' }, 'body.2': { field: 'payment_status' } },
  };
  await f.messaging.saveRule(scope, connection.id, 'orders/paid', rule);
  const payload = {
    id: 456,
    order_number: 77,
    phone: '+14155552671',
    customer: { id: 8 },
    financial_status: 'paid',
    note_attributes: [{ name: 'soft7_whatsapp_opt_in', value: 'true' }],
  };
  return { connection, rule, payload, templateId, phoneId };
}

test('eligible order notifications enter an encrypted outbox once and concurrent workers call the sender once', async () => {
  const f = fixture(),
    { connection, payload } = await enableMessaging(f);
  const w = webhook(connection, payload);
  await deliver(f, w);
  await deliver(f, w);
  await deliver(f, webhook(connection, payload));
  assert.equal(f.sends.length, 0, 'Webhook must never call Meta');
  assert.equal(f.database.tables().shopify_whatsapp_jobs.length, 1);
  assert.ok(!JSON.stringify(f.database.tables()).includes('+14155552671'));
  const claims = await Promise.all([f.messaging.claim(), f.messaging.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const job = claims.find(Boolean);
  await Promise.all([f.messaging.process(job), f.messaging.process(job)]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].data.to, '4155552671');
  assert.equal(f.sends[0].data.country_code, '1');
  assert.equal(f.sends[0].data.shopify_job_id, job.id);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0].data.template.components[0].parameters)), [
    { type: 'text', text: '77' },
    { type: 'text', text: 'paid' },
  ]);
  assert.equal(f.database.tables().shopify_whatsapp_jobs[0].status, 'sent');
});

test('order messages require explicit consent and an international customer/default/billing phone', async () => {
  const f = fixture(),
    { connection, payload } = await enableMessaging(f);
  const cases = [
    { ...payload, id: 1, note_attributes: [], sms_marketing_consent: { state: 'subscribed' } },
    { ...payload, id: 2, phone: '4155552671' },
    { ...payload, id: 3, phone: null, shipping_address: { phone: '+14155552671' } },
    { ...payload, id: 4, note_attributes: [{ name: 'soft7_whatsapp_opt_in', value: 'false' }] },
  ];
  for (const body of cases) await deliver(f, webhook(connection, body));
  assert.deepEqual(
    f.database.tables().shopify_whatsapp_jobs.map((j) => j.reason),
    ['consent_missing', 'phone_missing_or_invalid', 'phone_missing_or_invalid', 'consent_missing'],
  );
  assert.equal(await f.messaging.claim(), null);
  assert.equal(f.sends.length, 0);
  await deliver(f, webhook(connection, { ...payload, id: 5, phone: null, billing_address: { phone: '+14155552671' } }));
  assert.ok(await f.messaging.claim());
});

test('flow test webhooks use the store signing secret, bind owner/store/topic, deduplicate and never send WhatsApp', async () => {
  const f = fixture(), { connection } = await enableMessaging(f);
  const service = new ShopifyFlowWebhookService(f.database, (_ownerId, action) => f.database.transaction(action));
  const secret = 'a'.repeat(64);
  await assert.rejects(service.create(other, connection.id, { topic: 'orders/paid', signing_secret: secret }), /not found/);
  const created = await service.create(scope, connection.id, { name: 'Receive only', topic: 'orders/paid', signing_secret: secret });
  const token = new URL(created.webhook_url).pathname.split('/').pop();
  assert.ok(!JSON.stringify(created).includes(secret));
  const raw = Buffer.from(JSON.stringify({ id: 789, customer: { id: 88 }, phone: '+14155552671',
    note_attributes: [{ name: 'soft7_whatsapp_opt_in', value: 'true' }] }));
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const headers = { 'x-shopify-shop-domain': shop, 'x-shopify-topic': 'orders/paid', 'x-shopify-webhook-id': crypto.randomUUID() };
  const deliverFlow = (tokenValue = token, signatureValue = signature, headerValues = headers) =>
    service.receive(created.flow_id, tokenValue, raw, signatureValue, headerValues);
  await assert.rejects(deliverFlow(utils.random()), /invalid|expired/i);
  await assert.rejects(deliverFlow(token, crypto.createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET).update(raw).digest('base64')), /signature/);
  await assert.rejects(deliverFlow(token, signature, { ...headers, 'x-shopify-shop-domain': 'another.myshopify.com' }), /match/);
  await assert.rejects(deliverFlow(token, signature, { ...headers, 'x-shopify-topic': 'orders/create' }), /expects/);
  assert.equal((await deliverFlow()).accepted, true);
  assert.equal((await deliverFlow()).duplicate, true);
  assert.equal((await service.status(created.flow_id, token)).received, 1);
  assert.equal(f.database.tables().shopify_events[0].flow_id, created.flow_id);
  assert.equal((f.database.tables().shopify_whatsapp_jobs || []).length, 0);
  assert.equal(f.sends.length, 0);
  await assert.rejects(service.settings(other, connection.id, created.flow_id), /not found/);
  await privacyDelivery(f, connection, 'customers/redact', { customer: { id: 88 } });
  assert.equal((await f.service.maintainPrivacy()).failed, 0);
  assert.equal(f.database.tables().shopify_events[0].payload_ciphertext, null);
  await f.database('chat_bot').where({ id: created.flow_id }).update({ is_active: false });
  await assert.rejects(service.status(created.flow_id, token), /not active/);
  await assert.rejects(deliverFlow(), /not active/);
  await f.database('chat_bot').where({ id: created.flow_id }).update({ is_active: true });
  await f.database('shopify_flow_webhooks').where({ flow_id: created.flow_id }).update({ expires_at: new Date(0) });
  await assert.rejects(deliverFlow(), /expired/);
  await f.service.maintainPrivacy();
  assert.equal(f.database.tables().shopify_flow_webhooks[0].signing_secret_ciphertext, null);
});

test('all-events flow tests accept cart/checkout/customer/order receipts, minimize data and cannot run lifecycle or message actions', async () => {
  const f = fixture(), { connection } = await enableMessaging(f);
  const service = new ShopifyFlowWebhookService(f.database, (_owner, action) => f.database.transaction(action));
  const secret = 'b'.repeat(64);
  const flow = await service.create(scope, connection.id, { topic: '*', signing_secret: secret });
  const token = new URL(flow.webhook_url).pathname.split('/').pop();
  const raw = Buffer.from(JSON.stringify({ id: 789, order_id: 12345, customer: { id: 88 },
    phone: '+14155552671', email: 'private@example.test', note_attributes: [{ name: 'soft7_whatsapp_opt_in', value: 'true' }],
    billing_address: { address1: 'Private address' } }));
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const send = topic => service.receive(flow.flow_id, token, raw, signature, {
    'x-shopify-shop-domain': shop, 'x-shopify-topic': topic, 'x-shopify-webhook-id': crypto.randomUUID(),
  });
  for (const topic of utils.flowTestTopics) assert.equal((await send(topic)).accepted, true);
  const status = await service.status(flow.flow_id, token);
  assert.equal(status.received, utils.flowTestTopics.length);
  assert.equal(status.last_received_topic, 'checkouts/delete');
  assert.equal(status.accepted_topics.length, utils.flowTestTopics.length);
  const event = f.database.tables().shopify_events.find(e => e.topic === 'checkouts/update');
  const payload = (await f.service.event(scope, connection.id, event.id)).payload;
  assert.equal(payload.phone, undefined); assert.equal(payload.email, undefined);
  assert.equal(payload.billing_address, undefined); assert.equal(payload.note_attributes, undefined);
  for (const topic of ['app/uninstalled', 'shop/redact', 'products/create']) await assert.rejects(send(topic), /Unsupported/);
  await assert.rejects(deliver(f, webhook(connection, {}, 'carts/create')), /Unsupported/);
  assert.equal((f.database.tables().shopify_whatsapp_jobs || []).length, 0);
  await privacyDelivery(f, connection, 'customers/redact', { orders_to_redact: [12345] });
  assert.equal((await f.service.maintainPrivacy()).failed, 0);
  assert.equal(f.database.tables().shopify_events.find(e => e.id === event.id).payload_ciphertext, null);
  assert.equal(f.database.tables().shopify_connections[0].status, 'connected');
});

test('rules enforce owner, sender/WABA ownership, approved utility templates, subscription and consent configuration', async () => {
  const f = fixture(),
    { connection, rule, templateId } = await enableMessaging(f);
  await assert.rejects(f.messaging.settings(other, connection.id), /not found/);
  await assert.rejects(f.messaging.saveRule(scope, connection.id, 'customers/create', rule), /order event/);
  await assert.rejects(f.messaging.saveRule(scope, connection.id, 'orders/create', rule), /Choose your triggers/);
  await assert.rejects(
    f.messaging.saveRule(scope, connection.id, 'orders/paid', { ...rule, consent_confirmed: false }),
    /Confirm/,
  );
  await assert.rejects(
    f.messaging.saveRule(scope, connection.id, 'orders/paid', { ...rule, phone_number_id: crypto.randomUUID() }),
    /active WhatsApp/,
  );
  await f.database('templates').where({ id: templateId }).update({ category: 'MARKETING' });
  await assert.rejects(f.messaging.saveRule(scope, connection.id, 'orders/paid', rule), /approved utility/);
});

test('send-time opt-out, template withdrawal, rule edits and disconnect stop queued messages', async () => {
  for (const reason of ['optout', 'template', 'rule', 'disconnect']) {
    const f = fixture(),
      { connection, payload, templateId, rule } = await enableMessaging(f);
    await deliver(f, webhook(connection, payload));
    if (reason === 'optout') f.blocked.add('14155552671');
    if (reason === 'template') await f.database('templates').where({ id: templateId }).update({ status: 'PAUSED' });
    if (reason === 'rule') await f.messaging.saveRule(scope, connection.id, 'orders/paid', rule);
    if (reason === 'disconnect') await f.service.disconnect(scope, connection.id);
    const job = await f.messaging.claim();
    if (job) await f.messaging.process(job);
    assert.equal(f.sends.length, 0, reason);
    assert.ok(['skipped', 'cancelled'].includes(f.database.tables().shopify_whatsapp_jobs[0].status));
  }
});

test('uncertain sends and stale claims are visible for reconciliation and never retried automatically', async () => {
  const f = fixture(),
    { connection, payload } = await enableMessaging(f);
  await deliver(f, webhook(connection, payload));
  let attempts = 0;
  const worker = new ShopifyMessagingService(
    f.database,
    async () => {
      attempts++;
      throw Error('Timeout after acceptance');
    },
    async () => false,
  );
  const job = await worker.claim();
  await worker.process(job);
  assert.equal(f.database.tables().shopify_whatsapp_jobs[0].status, 'unknown');
  assert.equal(await worker.claim(), null);
  await worker.process(job);
  assert.equal(attempts, 1);
  await f
    .database('shopify_whatsapp_jobs')
    .where({ id: job.id })
    .update({ status: 'sending', started_at: new Date(0) });
  await worker.recoverStale();
  assert.equal(f.database.tables().shopify_whatsapp_jobs[0].status, 'unknown');
  assert.equal(await worker.claim(), null);
  assert.equal(attempts, 1);
});

test('privacy exports include queued/sent WhatsApp data and erasure removes outbound history and prevents queued sends', async () => {
  const f = fixture(),
    { connection, payload } = await enableMessaging(f);
  await deliver(f, webhook(connection, payload));
  const job = await f.messaging.claim();
  await f.messaging.process(job);
  const { request_id } = await privacyDelivery(f, connection, 'customers/data_request', { customer: { id: 8 } });
  const page = await f.service.privacyExport(scope, connection.id, request_id);
  assert.equal(page.next_section, 'messages');
  await assert.rejects(f.service.completePrivacyRequest(scope, connection.id, request_id, true), /Download/);
  const messages = await f.service.privacyExport(scope, connection.id, request_id, undefined, 'messages');
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].details.recipient.phone_number, '4155552671');
  assert.ok(messages.messages[0].outbound_message);
  await f.service.completePrivacyRequest(scope, connection.id, request_id, true);
  await deliver(f, webhook(connection, { ...payload, id: 457 }));
  const queued = await f.messaging.claim();
  await privacyDelivery(f, connection, 'customers/redact', { customer: { id: 8 } });
  await f.messaging.process(queued);
  assert.equal(f.sends.length, 1);
  await f.service.maintainPrivacy();
  assert.equal(f.database.tables().messages.length, 0);
  assert.ok(
    f.database.tables().shopify_whatsapp_jobs.every((j) => j.payload_ciphertext === null && j.resource_id === null),
  );
});

test('expiring a Shopify message job removes its linked outbound message history', async () => {
  const f = fixture(),
    { connection, payload } = await enableMessaging(f);
  await deliver(f, webhook(connection, payload));
  const job = await f.messaging.claim();
  await f.messaging.process(job);
  await f
    .database('shopify_whatsapp_jobs')
    .where({ id: job.id })
    .update({ expires_at: new Date(0) });
  await f.service.maintainPrivacy();
  assert.equal(f.database.tables().shopify_whatsapp_jobs.length, 0);
  assert.equal(f.database.tables().messages.length, 0);
});

test('event inbox excludes contact details, addresses, notes and arbitrary webhook fields', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  const w = webhook(connection, {
    id: 456,
    email: 'buyer@example.test',
    phone: '+91 99999 99999',
    customer: { id: 8, first_name: 'Private', email: 'buyer@example.test' },
    shipping_address: { address1: 'Private street' },
    note: 'Private note',
    line_items: [{ title: 'Private item' }],
    financial_status: 'paid',
    created_at: '2026-10-17T00:00:00Z',
  });
  await deliver(f, w);
  const row = f.database.tables().shopify_events[0];
  const detail = await f.service.event(scope, connection.id, row.id);
  assert.deepEqual(JSON.parse(JSON.stringify(detail.payload)), {
    id: '456',
    customer: { id: '8' },
    financial_status: 'paid',
    created_at: '2026-10-17T00:00:00.000Z',
  });
  assert.equal(row.payload_version, 1);
  const serialized = JSON.stringify(f.database.tables());
  for (const secret of ['buyer@example.test', 'Private street', 'Private note', 'Private item'])
    assert.ok(!serialized.includes(secret));
  assert.equal(f.database.tables().shopify_data_access_log[0].action, 'event.read');
});

test('order-only and contact-only erasure scrub legacy data and suppress retries without erasing another account', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  const ctx = `${scope.companyId}:${scope.ownerId}:${shop}`;
  for (const [id, payload] of [
    [501, { id: 501, email: 'Buyer@example.test', note: 'secret' }],
    [502, { id: 502, phone: '+91 99999 99999' }],
    [503, { id: 503 }],
    [504, { id: 504, customer: { id: 99 } }],
  ]) {
    await f.database('shopify_events').insert({
      connection_id: connection.id,
      delivery_id: crypto.randomUUID(),
      topic: 'orders/paid',
      resource_id: String(id),
      payload_ciphertext: utils.encrypt(JSON.stringify(payload), ctx),
      payload_version: 0,
    });
  }
  const foreignId = crypto.randomUUID();
  await f.database('shopify_connections').insert({
    id: foreignId,
    company_id: other.companyId,
    owner_id: other.ownerId,
    shop_domain: 'foreign.myshopify.com',
  });
  await f.database('shopify_events').insert({
    connection_id: foreignId,
    topic: 'orders/paid',
    payload_version: 1,
    payload_ciphertext: 'foreign ciphertext',
    subject_hashes: JSON.stringify(utils.subjectHashes('orders/paid', { id: 503 }, ctx)),
  });
  const first = await privacyDelivery(f, connection, 'customers/redact', { customer: { email: 'buyer@example.test' } });
  await privacyDelivery(f, connection, 'customers/redact', { customer: { phone: '+919999999999' } });
  await privacyDelivery(f, connection, 'customers/redact', { orders_to_redact: [503] });
  assert.equal((await deliver(f, webhook(connection, { id: 503 }))).ignored, true);
  assert.equal(
    (f.database.tables().shopify_redactions || []).length,
    0,
    'Erasure acknowledgement must not write one suppression row per subject',
  );
  const counts = await f.service.maintainPrivacy();
  assert.equal(counts.redacted, 3);
  const rows = f.database.tables().shopify_events.filter((e) => e.connection_id === connection.id);
  assert.equal(rows.filter((e) => e.status === 'redacted').length, 3);
  assert.equal(rows.filter((e) => e.payload_ciphertext).length, 1);
  assert.equal(
    f.database.tables().shopify_events.find((e) => e.connection_id === foreignId).payload_ciphertext,
    'foreign ciphertext',
  );
  assert.equal(
    f.database.tables().shopify_privacy_requests.find((r) => r.id === first.request_id).payload_ciphertext,
    null,
  );
  assert.equal((await deliver(f, webhook(connection, { id: 503 }))).ignored, true);
  assert.equal((await deliver(f, webhook(connection, { id: 600, email: 'buyer@example.test' }))).ignored, true);
});

test('data export pages include only matching retained events; only the owner can export and confirm delivery', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  const ctx = `${scope.companyId}:${scope.ownerId}:${shop}`;
  for (let i = 0; i < 205; i++) {
    const payload = { id: 1000 + i, customer: { id: 8 } };
    await f.database('shopify_events').insert({
      connection_id: connection.id,
      topic: 'orders/paid',
      payload_version: 1,
      payload_ciphertext: utils.encrypt(JSON.stringify(payload), ctx),
      subject_hashes: JSON.stringify(utils.subjectHashes('orders/paid', payload, ctx)),
    });
  }
  await f.database('shopify_events').insert({
    connection_id: connection.id,
    topic: 'orders/paid',
    payload_version: 1,
    payload_ciphertext: utils.encrypt('{"id":999,"customer":{"id":99}}', ctx),
    subject_hashes: JSON.stringify(utils.subjectHashes('orders/paid', { id: 999, customer: { id: 99 } }, ctx)),
  });
  const { request_id } = await privacyDelivery(f, connection, 'customers/data_request', { customer: { id: 8 } });
  await assert.rejects(f.service.privacyExport(other, connection.id, request_id), /not found/);
  await assert.rejects(f.service.completePrivacyRequest(scope, connection.id, request_id, true), /Download/);
  const page1 = await f.service.privacyExport(scope, connection.id, request_id);
  assert.equal(page1.events.length, 200);
  assert.ok(page1.next_cursor);
  await assert.rejects(f.service.completePrivacyRequest(scope, connection.id, request_id, true), /Download/);
  const page2 = await f.service.privacyExport(scope, connection.id, request_id, page1.next_cursor);
  assert.equal(page2.events.length, 5);
  assert.equal(page2.next_cursor, null);
  assert.equal(new Set([...page1.events, ...page2.events].map((e) => e.id)).size, 205);
  await assert.rejects(f.service.completePrivacyRequest(scope, connection.id, request_id, false), /Confirm/);
  await f.service.completePrivacyRequest(scope, connection.id, request_id, true);
  const request = f.database.tables().shopify_privacy_requests[0];
  assert.equal(request.status, 'completed');
  assert.equal(request.completed_by, scope.userId);
  assert.equal(request.payload_ciphertext, null);
  assert.equal(request.subject_hashes.length, 0);
  await assert.rejects(f.service.privacyExport(scope, connection.id, request_id), /not found/);
});

test('retention hides expired inbox data, holds it for pending requests, and removes it after fulfilment', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  await deliver(f, webhook(connection));
  const row = f.database.tables().shopify_events[0];
  await f
    .database('shopify_events')
    .where({ id: row.id })
    .update({ expires_at: new Date(0) });
  await assert.rejects(f.service.event(scope, connection.id, row.id), /not found/);
  assert.equal((await f.service.events(scope, connection.id)).events.length, 0);
  const { request_id } = await privacyDelivery(f, connection, 'customers/data_request', { customer: { id: 8 } });
  await f
    .database('shopify_privacy_requests')
    .where({ id: request_id })
    .update({ due_at: new Date(0) });
  const stats = await f.service.maintainPrivacy();
  assert.equal(stats.overdue, 1);
  assert.equal(f.database.tables().shopify_events.length, 1);
  const page = await f.service.privacyExport(scope, connection.id, request_id);
  assert.equal(page.events.length, 1);
  await f.service.completePrivacyRequest(scope, connection.id, request_id, true);
  await f.service.maintainPrivacy();
  assert.equal(f.database.tables().shopify_events.length, 0);
  assert.equal((await f.service.privacyRequests(scope, connection.id)).pending, 0);
});

test('damaged data in one store does not prevent another store from completing erasure', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  await deliver(f, webhook(connection));
  await privacyDelivery(f, connection, 'customers/redact', { customer: { id: 8 } });
  const foreignId = crypto.randomUUID();
  await f.database('shopify_connections').insert({
    id: foreignId,
    company_id: other.companyId,
    owner_id: other.ownerId,
    shop_domain: 'damaged.myshopify.com',
  });
  await f.database('shopify_events').insert({
    connection_id: foreignId,
    topic: 'orders/paid',
    payload_version: 0,
    payload_ciphertext: 'not decryptable',
  });
  const result = await f.service.maintainPrivacy();
  assert.equal(result.failed, 1);
  assert.equal(result.redacted, 1);
  assert.equal(
    f.database.tables().shopify_events.find((e) => e.connection_id === connection.id).payload_ciphertext,
    null,
  );
  assert.equal(f.database.tables().shopify_events.find((e) => e.connection_id === foreignId).payload_version, 0);
});

test('shop erasure cascades all inbox, privacy and audit records; maintenance removes uninstalled stores after 48 hours', async () => {
  for (const fallback of [false, true]) {
    const f = fixture(),
      { connection } = await connected(f);
    await privacyDelivery(f, connection, 'customers/data_request', { customer: { id: 8 } });
    await f.database('shopify_data_access_log').insert({ connection_id: connection.id, actor_id: scope.userId });
    await f.database('shopify_redactions').insert({ connection_id: connection.id, subject_hash: 'test' });
    if (fallback) {
      await f
        .database('shopify_connections')
        .where({ id: connection.id })
        .update({ status: 'uninstalled', updated_at: new Date(Date.now() - 49 * 3600000) });
      await f.service.maintainPrivacy();
    } else await privacyDelivery(f, connection, 'shop/redact', {});
    for (const table of [
      'shopify_connections',
      'shopify_events',
      'shopify_privacy_requests',
      'shopify_redactions',
      'shopify_data_access_log',
    ])
      assert.equal((f.database.tables()[table] || []).length, 0, table);
  }
});

test('store domains are canonical and cannot redirect credentials to another host', () => {
  assert.equal(utils.shopDomain(' My-Store '), shop);
  for (const input of [
    'https://my-store.myshopify.com',
    'evil.test',
    'a.myshopify.com.evil.test',
    'a.myshopify.com/path',
    'a@myshopify.com',
    'a.myshopify.com:443',
    'localhost',
    'a/b',
  ]) {
    // A bare store name such as localhost is safe: it is expanded only under myshopify.com.
    if (input === 'localhost') assert.equal(utils.shopDomain(input), 'localhost.myshopify.com');
    else assert.throws(() => utils.shopDomain(input));
  }
});
test('tokens are encrypted, tenant-bound and tamper-resistant', () => {
  const encrypted = utils.encrypt('token', 'tenant-a');
  assert.ok(!encrypted.includes('token'));
  assert.equal(utils.decrypt(encrypted, 'tenant-a'), 'token');
  assert.throws(() => utils.decrypt(encrypted, 'tenant-b'));
  assert.throws(() => utils.decrypt(encrypted.slice(0, -4), 'tenant-a'));
});
test('OAuth verifies all signed query parameters, expiry and scalar types', () => {
  const valid = signedQuery({ shop, code: 'code', state: 'state', host: 'base64-host' });
  assert.equal(utils.verifyCallback(valid).shop, shop);
  assert.throws(() => utils.verifyCallback({ ...valid, shop: 'other.myshopify.com' }));
  assert.throws(() => utils.verifyCallback({ ...valid, state: ['state', 'state'] }));
  assert.throws(() => utils.verifyCallback(signedQuery({ shop, timestamp: '1000000000' })));
});
test('OAuth sessions are browser-bound, store-bound and one-use; encrypted credentials never appear in connection lists', async () => {
  const f = fixture(),
    start = await f.service.start(scope, { shop });
  const state = new URL(start.authorization_url).searchParams.get('state');
  const query = signedQuery({ shop, state, code: 'code' });
  await assert.rejects(f.service.callback(query, utils.random()), /expired|used/);
  await assert.rejects(
    f.service.callback(signedQuery({ shop: 'other.myshopify.com', state, code: 'code' }), start.browser),
  );
  await f.service.callback(query, start.browser);
  await assert.rejects(f.service.callback(query, start.browser), /expired|used/);
  assert.equal(f.calls.exchange, 1);
  const serialized = JSON.stringify(await f.service.connections(scope));
  for (const secret of ['private-access', 'private-refresh', 'ciphertext', 'delivery_token'])
    assert.ok(!serialized.includes(secret));
});
test('other companies and account members cannot take over a store or modify its subscriptions', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await assert.rejects(f.service.start(other, { shop }), /another RSVPDesk/);
  await assert.rejects(f.service.saveTriggers(other, connection.id, ['orders/paid']), /not found/);
  await assert.rejects(f.service.events(other, connection.id), /not found/);
  await assert.rejects(
    f.service.sync({ ...scope, userId: crypto.randomUUID() }, connection.id),
    /Only the account owner/,
  );
  assert.equal(f.database.tables().shopify_connections[0].subscription_issue, null);
});
test('trigger synchronization reuses remote subscriptions, removes obsolete ones and preserves unrelated destinations', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  f.remote.push({ id: 'unrelated', topic: 'ORDERS_PAID', uri: 'https://other.example.test/hooks' });
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  const count = f.calls.subscribe;
  await f.service.sync(scope, connection.id);
  assert.equal(f.calls.subscribe, count);
  await f.service.saveTriggers(scope, connection.id, []);
  assert.ok(f.remote.some((s) => s.id === 'unrelated'));
  assert.ok(!f.remote.some((s) => s.id !== 'unrelated' && s.topic === 'ORDERS_PAID'));
  await assert.rejects(f.service.saveTriggers(scope, connection.id, ['abandoned_checkouts/create']), /supported/);
});
test('expired credentials refresh and rotate once across serialized operations', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await f
    .database('shopify_connections')
    .where({ id: connection.id })
    .update({ token_expires_at: new Date(0) });
  const [verification] = await Promise.all([f.service.verifyConnection(scope, connection.id), f.service.sync(scope, connection.id)]);
  assert.equal(verification.store_identity_matches, true);
  assert.ok(!JSON.stringify(verification).includes('private-access'));
  assert.ok(!JSON.stringify(verification).includes('/webhook/'));
  await assert.rejects(f.service.verifyConnection(other, connection.id), /not found/);
  assert.equal(f.calls.refresh, 1);
  const c = f.database.tables().shopify_connections[0];
  assert.equal(utils.decrypt(c.refresh_token_ciphertext, `${scope.companyId}:${scope.ownerId}:${shop}`), 'new-refresh');
  await f.database('shopify_connections').where({ id: connection.id }).update({ token_expires_at: new Date(0) });
  f.client.subscriptions = async () => { throw Error('Diagnostic upstream unavailable'); };
  await assert.rejects(f.service.verifyConnection(scope, connection.id), /unavailable/);
  assert.equal(f.calls.refresh, 2);
  assert.ok(new Date(f.database.tables().shopify_connections[0].token_expires_at).getTime() > Date.now());
  await assert.rejects(f.service.verifyConnection(scope, connection.id), /unavailable/);
  assert.equal(f.calls.refresh, 2);
});
test('changing the callback host replaces owned old destinations and preserves unrelated subscriptions', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  const previous = process.env.SHOPIFY_REDIRECT_URI;
  try {
    process.env.SHOPIFY_REDIRECT_URI = 'https://new.example.test/v1/integrations/shopify/callback';
    await f.service.sync(scope, connection.id);
    assert.equal(f.remote.length, 3);
    assert.ok(f.remote.every((s) => s.uri.startsWith('https://new.example.test/')));
  } finally {
    process.env.SHOPIFY_REDIRECT_URI = previous;
  }
});
test('a webhook gets a retryable response while store setup holds its advisory lock', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  f.database.raw = async () => ({ rows: [{ locked: false }] });
  await assert.rejects(deliver(f, webhook(connection)), (error) => error.statusCode === 503);
  assert.equal(f.database.tables().shopify_events?.length || 0, 0);
});
test('a delayed uninstall from an older installation cannot erase a reconnect', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  const w = webhook(connection, { id: 123 }, 'app/uninstalled');
  w.headers['x-shopify-triggered-at'] = new Date(new Date(connection.connected_at).getTime() - 1000).toISOString();
  await deliver(f, w);
  assert.equal(f.database.tables().shopify_connections[0].status, 'connected');
  assert.ok(f.database.tables().shopify_connections[0].access_token_ciphertext);
});

test('customer erasure suppression cannot block credential clearing on uninstall', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await privacyDelivery(f, connection, 'customers/redact', { customer: { email: 'owner@example.test' } });
  const w = webhook(connection, { id: 123, email: 'owner@example.test' }, 'app/uninstalled');
  w.headers['x-shopify-triggered-at'] = new Date(Date.now() + 1000).toISOString();
  await deliver(f, w);
  assert.equal(f.database.tables().shopify_connections[0].access_token_ciphertext, null);
  assert.equal(f.database.tables().shopify_connections[0].status, 'uninstalled');
});
test('signed webhooks are store-bound, persisted encrypted and deduplicated', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  const w = webhook(connection);
  await assert.rejects(deliver(f, { ...w, signature: 'invalid' }));
  await assert.rejects(deliver(f, { ...w, raw: Buffer.from('{}') }));
  await assert.rejects(deliver(f, { ...w, token: utils.random() }), /destination/);
  await assert.rejects(deliver(f, { ...w, id: crypto.randomUUID() }), /destination/);
  await deliver(f, w);
  assert.equal((await deliver(f, w)).duplicate, true);
  assert.equal(f.database.tables().shopify_events.length, 1);
  assert.ok(!JSON.stringify(f.database.tables().shopify_events).includes('+919999999999'));
  const events = await f.service.events(scope, connection.id);
  const detail = await f.service.event(scope, connection.id, events.events[0].id);
  assert.equal(detail.payload.id, '456');
  await assert.rejects(f.service.event(other, connection.id, detail.id), /not found/);
});
test('unknown or inactive topics cannot create trigger events; uninstall clears credentials and subscriptions', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  assert.equal((await deliver(f, webhook(connection))).ignored, true);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  const w = webhook(connection, { id: 123 }, 'app/uninstalled');
  w.headers['x-shopify-triggered-at'] = new Date(Date.now() + 1000).toISOString();
  await deliver(f, w);
  const c = f.database.tables().shopify_connections[0];
  assert.equal(c.status, 'uninstalled');
  assert.equal(c.access_token_ciphertext, null);
  assert.equal(f.database.tables().shopify_subscriptions.length, 0);
  assert.equal((await deliver(f, webhook(connection))).ignored, true);
});
test('customer redaction removes stored customer payloads and the shared endpoint rejects ordinary event topics', async () => {
  const f = fixture(),
    { connection } = await connected(f);
  await f.service.saveTriggers(scope, connection.id, ['orders/paid']);
  await deliver(f, webhook(connection));
  const normal = webhook(connection);
  await assert.rejects(f.service.receive(normal.raw, normal.signature, normal.headers), /registered webhook/);
  const w = webhook(connection, { shop_id: 123, shop_domain: shop, customer: { id: 8 } }, 'customers/redact');
  await f.service.receive(w.raw, w.signature, w.headers);
  await f.service.maintainPrivacy();
  assert.ok(f.database.tables().shopify_events.every((e) => e.payload_ciphertext === null && e.customer_id === null));
});
test('subscription failure preserves the store connection and supports repair after remote success and local rollback', async () => {
  const f = fixture(),
    { connection } = await connected(f),
    original = f.client.subscribe;
  let fail = true;
  f.client.subscribe = async (...args) => {
    const result = await original(...args);
    if (args[2] === 'ORDERS_PAID' && fail) {
      fail = false;
      throw Error('response lost');
    }
    return result;
  };
  await assert.rejects(f.service.saveTriggers(scope, connection.id, ['orders/paid']));
  assert.equal(f.database.tables().shopify_connections[0].status, 'connected');
  assert.ok(f.database.tables().shopify_connections[0].subscription_issue);
  await f.service.sync(scope, connection.id);
  assert.equal(f.remote.filter((s) => s.topic === 'ORDERS_PAID').length, 1);
  assert.equal(f.database.tables().shopify_connections[0].subscription_issue, null);
});
test('HTTP routes expose the test page, protect owner APIs, retain raw bodies and never expose app secrets', async () => {
  const express = require('express'),
    f = fixture();
  const controller = load('src/app/http/controllers/shopify.controller.ts', {
    '@surefy/utils/Controller': require('../library/surefy/src/utils/Controller'),
    '../../services/shopify.service': f.service,
    '../../services/shopifyMessaging.service': f.messaging,
    '../../services/shopifyFlowWebhook.service': new ShopifyFlowWebhookService(f.database,
      (_ownerId, action) => f.database.transaction(action)),
    '../../utils/shopify': utils,
  });
  const route = load('src/routes/shopify.route.ts', {
    express,
    '../app/http/controllers/shopify.controller': controller,
    '@surefy/middleware/jwtAuth.middleware': {
      requireRole: () => (req, res, next) => (req.userRole === 'user' ? next() : res.sendStatus(403)),
    },
    '../app/http/middleware/accountScope': { accountScope: (_req, _res, next) => next() },
  }).default;
  const publicRoute = load('src/routes/shopifyPublic.route.ts', {
    express,
    '../app/http/controllers/shopify.controller': controller,
  }).default;
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, raw) => {
        req.rawBody = Buffer.from(raw);
      },
    }),
  );
  app.use(
    '/v1/admin/shopify',
    (req, res, next) => {
      if (!req.headers.authorization) return res.sendStatus(401);
      Object.assign(req, scope, { userRole: req.headers.authorization === 'Bearer member' ? 'member' : 'user' });
      next();
    },
    route,
  );
  app.use('/v1/integrations/shopify', publicRoute);
  app.use((error, _req, res, _next) =>
    res.status(error.statusCode || 500).json({ success: false, message: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const merchantPage = await fetch(base + '/v1/integrations/shopify/app');
    assert.equal(merchantPage.status, 200);
    assert.match(await merchantPage.text(), /Data requests/);
    const previousController = process.env.SHOPIFY_PRIVACY_CONTROLLER;
    const previousEmail = process.env.SHOPIFY_PRIVACY_EMAIL;
    try {
      process.env.SHOPIFY_PRIVACY_CONTROLLER = 'Soft7 <Test>';
      process.env.SHOPIFY_PRIVACY_EMAIL = 'privacy@example.test';
      const privacy = await fetch(base + '/v1/integrations/shopify/privacy');
      assert.equal(privacy.status, 200);
      assert.match(await privacy.text(), /Soft7 &lt;Test&gt;/);
      delete process.env.SHOPIFY_PRIVACY_EMAIL;
      assert.equal((await fetch(base + '/v1/integrations/shopify/privacy')).status, 503);
    } finally {
      if (previousController === undefined) delete process.env.SHOPIFY_PRIVACY_CONTROLLER;
      else process.env.SHOPIFY_PRIVACY_CONTROLLER = previousController;
      if (previousEmail === undefined) delete process.env.SHOPIFY_PRIVACY_EMAIL;
      else process.env.SHOPIFY_PRIVACY_EMAIL = previousEmail;
    }
    const invalidSignature = await fetch(base + '/v1/integrations/shopify/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(invalidSignature.status, 401);
    const page = await fetch(base + '/v1/integrations/shopify/test');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Connect Shopify/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const config = await fetch(base + '/v1/integrations/shopify/test-config');
    assert.ok(!(await config.text()).includes('test-app-secret'));
    assert.equal((await fetch(base + '/v1/admin/shopify/connections')).status, 401);
    assert.equal(
      (await fetch(base + '/v1/admin/shopify/connections', { headers: { Authorization: 'Bearer member' } })).status,
      403,
    );
    const start = await fetch(base + '/v1/admin/shopify/oauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop }),
    });
    assert.equal(start.status, 200);
    assert.match(start.headers.get('set-cookie'), /HttpOnly/);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    const authorization = (await start.json()).data.authorization_url;
    assert.ok(!authorization.includes('test-app-secret'));
    const oauthQuery = signedQuery({ shop, state: new URL(authorization).searchParams.get('state'), code: 'fixture-code' });
    const oauthResponse = await fetch(base + '/v1/integrations/shopify/callback?' + new URLSearchParams(oauthQuery), {
      redirect: 'manual',
      headers: { Cookie: start.headers.get('set-cookie').split(';')[0] },
    });
    assert.equal(oauthResponse.status, 303);
    assert.equal(oauthResponse.headers.get('location'), '/v1/integrations/shopify/app');
    assert.match(oauthResponse.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    assert.equal(oauthResponse.headers.get('cache-control'), 'no-store');
    assert.ok(!(await oauthResponse.text()).includes('fixture-code'));
    const c = (await connected(f)).connection;
    await f.service.saveTriggers(scope, c.id, ['orders/paid']);
    const w = webhook(c);
    const response = await fetch(`${base}/v1/integrations/shopify/webhook/${c.id}/${w.token}`, {
      method: 'POST',
      headers: { ...w.headers, 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': w.signature },
      body: w.raw,
    });
    assert.equal(response.status, 200);
    assert.equal(f.database.tables().shopify_events.length, 1);
    const createFlow = await fetch(`${base}/v1/admin/shopify/connections/${c.id}/test-flows`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HTTP receipt test', topic: 'orders/paid', signing_secret: 'e'.repeat(64) }),
    });
    assert.equal(createFlow.status, 201);
    const flow = (await createFlow.json()).data;
    const flowPath = new URL(flow.webhook_url).pathname;
    const flowRaw = JSON.stringify({ id: 888, customer: { id: 8 } });
    const flowDelivery = await fetch(base + flowPath, {
      method: 'POST', headers: { ...w.headers, 'x-shopify-webhook-id': crypto.randomUUID(),
        'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', 'e'.repeat(64)).update(flowRaw).digest('base64') },
      body: flowRaw,
    });
    assert.equal(flowDelivery.status, 200);
    const statusResponse = await fetch(base + flowPath + '?format=json');
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.data.received, 1);
    assert.equal(statusBody.data.customer, undefined);
    const flowPage = await fetch(base + flowPath);
    assert.equal(flowPage.status, 200);
    assert.match(await flowPage.text(), /Events received/);
    assert.equal(flowPage.headers.get('cache-control'), 'no-store');
    const postPrivacy = async (topic, fields = {}) => {
      const delivery = webhook(c, { shop_id: 123, shop_domain: shop, ...fields }, topic);
      const response = await fetch(base + '/v1/integrations/shopify/webhook', {
        method: 'POST', headers: { ...delivery.headers, 'Content-Type': 'application/json',
          'X-Shopify-Hmac-Sha256': delivery.signature }, body: delivery.raw,
      });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    const request = await postPrivacy('customers/data_request', { customer: { id: 8 } });
    const exportResponse = await fetch(`${base}/v1/admin/shopify/connections/${c.id}/privacy-requests/${request.request_id}/export`, {
      headers: { Authorization: 'Bearer owner' },
    });
    assert.equal(exportResponse.status, 200);
    assert.ok((await exportResponse.json()).data.events.some(e => e.payload.id === '456'));
    const complete = await fetch(`${base}/v1/admin/shopify/connections/${c.id}/privacy-requests/${request.request_id}/complete`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivered: true }),
    });
    assert.equal(complete.status, 200);
    await postPrivacy('customers/redact', { customer: { id: 8 } });
    assert.equal((await f.service.maintainPrivacy()).failed, 0);
    assert.equal(f.database.tables().shopify_events[0].payload_ciphertext, null);
    await postPrivacy('shop/redact');
    assert.equal(f.database.tables().shopify_connections.length, 0);
    assert.equal((await fetch(base + flowPath)).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('upstream errors never leak access tokens, app secrets or raw Axios errors', async () => {
  const { ShopifyClient } = load('src/app/services/shopifyClient.service.ts', {
    axios: {
      post: async () => {
        throw { response: { status: 403 }, config: { secret: 'private-app-secret' } };
      },
    },
    '../utils/shopify': utils,
  });
  await assert.rejects(
    new ShopifyClient().identity(shop, 'private-access-token'),
    (error) => error.statusCode === 403 && !error.message.includes('private'),
  );
});
test('base middleware retains exact Shopify raw bytes, restricts credentialed CORS and suppresses callback and destination logs', async () => {
  const express = require('express'),
    logged = [];
  const previousMode = process.env.WORKER_MODE,
    previousOrigin = process.env.SHOPIFY_FRONTEND_URL;
  process.env.WORKER_MODE = 'true';
  process.env.SHOPIFY_FRONTEND_URL = 'https://dashboard.example.test';
  const routes = express.Router();
  routes.post('/integrations/shopify/webhook/:id/:token', (req, res) => res.json({ raw: req.rawBody.toString('hex') }));
  routes.get('/integrations/shopify/callback', (_req, res) => res.sendStatus(200));
  routes.get('/admin/shopify/setup', (_req, res) => res.sendStatus(200));
  const createApp = load('library/surefy/src/server.ts', {
    './exceptions/CustomError': { CustomError },
    './middleware/errorHandler': { errorHandler: (_e, _req, res, _next) => res.sendStatus(500) },
    './routes/health.route': express.Router(),
    './middleware/upload.middleware': { UPLOADS_DIR: require('node:os').tmpdir() },
    morgan: (_format, options) => (req, _res, next) => {
      if (!options.skip(req)) logged.push(req.originalUrl);
      next();
    },
  }).default;
  const app = createApp([{ basePath: '/v1', route: routes }]);
  if (previousMode === undefined) delete process.env.WORKER_MODE;
  else process.env.WORKER_MODE = previousMode;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + '/v1/admin/shopify/setup', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dashboard.example.test',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://dashboard.example.test');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    const wrongOrigin = await fetch(base + '/v1/admin/shopify/setup', {
      headers: { Origin: 'https://attacker.example.test' },
    });
    assert.notEqual(wrongOrigin.headers.get('access-control-allow-origin'), 'https://attacker.example.test');
    const raw = '{ "id": 5, "note": "exact bytes" }';
    const received = await fetch(base + '/v1/integrations/shopify/webhook/store/private-destination', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });
    assert.equal((await received.json()).raw, Buffer.from(raw).toString('hex'));
    await fetch(base + '/v1/integrations/shopify/callback?code=private-code');
    assert.ok(!logged.some((path) => path.includes('private-code') || path.includes('private-destination')));
  } finally {
    if (previousOrigin === undefined) delete process.env.SHOPIFY_FRONTEND_URL;
    else process.env.SHOPIFY_FRONTEND_URL = previousOrigin;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('Shopify migration compiles account foreign keys, unique delivery receipts and store ownership for PostgreSQL', async () => {
  const knex = require('knex')({ client: 'pg' }),
    migration = require('../src/database/migrations/20261016000002_create_shopify');
  const statements = [];
  const schema = {
    createTable: async (...args) => {
      statements.push(
        ...knex.schema
          .createTable(...args)
          .toSQL()
          .map((q) => q.sql),
      );
    },
  };
  try {
    await migration.up({ schema, raw: knex.raw.bind(knex), fn: knex.fn });
    const sql = statements.join('\n');
    assert.match(sql, /shopify_connections/);
    assert.match(sql, /shopify_events_connection_id_delivery_id_unique/);
    assert.match(sql, /shop_domain_unique/);
    assert.match(sql, /references "companies"/);
  } finally {
    await knex.destroy();
  }
});
