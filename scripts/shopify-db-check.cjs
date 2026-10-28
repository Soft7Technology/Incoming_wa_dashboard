require('dotenv/config');
require('ts-node/register');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load } = require('../tests/shopify-helpers.cjs');
const { CustomError } = require('../library/surefy/src/exceptions/CustomError');
const knex = require('knex');
const rollback = new Error('Intentional Shopify fixture rollback');
let stage = 'fixture setup';
(async () => {
  if (process.env.NODE_ENV !== 'development') throw new Error('This fixture requires the development database.');
  const database = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 0, max: 2 },
    acquireConnectionTimeout: 10000,
  });
  const utils = load('src/app/utils/shopify.ts', { '@surefy/exceptions/CustomError': { CustomError } });
  const messagingUtils = load('src/app/utils/shopifyMessaging.ts', {
    './shopify': utils,
    './importPhone': require('../src/app/utils/importPhone'),
    './reminder': require('../src/app/utils/reminder'),
  });
  const { ShopifyMessagingService } = load('src/app/services/shopifyMessaging.service.ts', {
    '@surefy/database': () => {
      throw Error('Inject fixture transaction');
    },
    '../utils/shopify': utils,
    '../utils/shopifyMessaging': messagingUtils,
  });
  const { ShopifyService } = load('src/app/services/shopify.service.ts', {
    '@surefy/database': () => {
      throw Error('Inject fixture transaction');
    },
    './shopifyClient.service': { ShopifyClient: class {} },
    '../utils/shopify': utils,
    '../utils/shopifyMessaging': messagingUtils,
  });
  const { ShopifyFlowWebhookService } = load('src/app/services/shopifyFlowWebhook.service.ts', {
    '@surefy/database': {}, './shopify.service': { ShopifyService }, '../utils/shopify': utils,
  });
  const schema = 'shopify_check_' + crypto.randomBytes(8).toString('hex');
  try {
    await database
      .transaction(async (trx) => {
        await trx.raw('create schema ??', [schema]);
        await trx.raw("select set_config('search_path', ?, true)", [schema + ',public']);
        for (const table of ['companies', 'users'])
          await trx.schema.createTable(table, (t) => {
            t.uuid('id').primary();
            if (table === 'users') t.uuid('company_id');
            t.string('status');
            t.timestamp('deleted_at');
          });
        await require('../src/database/migrations/20261016000002_create_shopify').up(trx);
        await require('../src/database/migrations/20261017000001_shopify_privacy').up(trx);
        for (const table of ['waba_accounts', 'phone_numbers', 'templates'])
          await trx.schema.createTable(table, (t) => {
            t.uuid('id').primary();
            t.uuid('company_id');
            t.uuid('user_id');
            t.uuid('waba_id');
            t.string('status');
            t.timestamp('deleted_at');
            if (table === 'phone_numbers') {
              t.string('phone_number_id');
              t.string('display_phone_number');
            }
            if (table === 'templates') {
              t.string('name');
              t.string('language');
              t.string('category');
              t.jsonb('components');
            }
          });
        await trx.schema.createTable('messages', (t) => {
          t.uuid('id').primary();
          t.uuid('company_id');
          t.string('wamid');
          t.string('status');
          t.jsonb('content');
          t.string('to_phone');
          t.timestamp('created_at').defaultTo(trx.fn.now());
        });
        await require('../src/database/migrations/20261017000002_shopify_whatsapp').up(trx);
        await trx.schema.createTable('chat_bot', t => {
          t.uuid('id').primary(); t.uuid('user_id'); t.uuid('company_id');
          t.string('name'); t.text('description'); t.string('status'); t.string('flow_type');
          t.boolean('published'); t.boolean('is_active');
        });
        for (const table of ['chat_bot_node', 'chat_bot_edge'])
          await trx.schema.createTable(table, t => {
            t.uuid('id').primary(); t.uuid('chatBotId'); t.uuid('user_id'); t.jsonb('data');
            if (table === 'chat_bot_node') { t.string('type'); t.jsonb('position'); }
            else { t.uuid('source'); t.uuid('target'); t.string('label'); }
          });
        await require('../src/database/migrations/20261017000003_shopify_flow_webhooks').up(trx);
        const scope = { companyId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
        scope.userId = scope.ownerId;
        await trx('companies').insert({ id: scope.companyId, status: 'active' });
        await trx('users').insert({ id: scope.ownerId, company_id: scope.companyId, status: 'active' });
        const shop = 'rsvpdesk-fixture.myshopify.com',
          subscriptions = [];
        const client = {
          exchange: async () => ({
            access_token: 'fixture-access',
            refresh_token: 'fixture-refresh',
            expires_in: 3600,
            refresh_token_expires_in: 7776000,
            scope: 'read_orders,read_customers',
          }),
          identity: async () => ({
            shop: { id: 'gid://shopify/Shop/123', myshopifyDomain: shop },
            currentAppInstallation: { accessScopes: ['read_orders', 'read_customers'].map((handle) => ({ handle })) },
          }),
          subscriptions: async () => subscriptions,
          subscribe: async (_shop, _token, topic, uri) => {
            const record = { id: crypto.randomUUID(), topic, uri };
            subscriptions.push(record);
            return record;
          },
        };
        const service = new ShopifyService(trx, client),
          start = await service.start(scope, { shop });
        const q = {
          shop,
          code: 'fixture-code',
          state: new URL(start.authorization_url).searchParams.get('state'),
          timestamp: String(Math.floor(Date.now() / 1000)),
        };
        q.hmac = crypto
          .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
          .update(
            Object.keys(q)
              .sort()
              .map((k) => `${k}=${q[k]}`)
              .join('&'),
          )
          .digest('hex');
        const connected = await service.callback(q, start.browser);
        const contention = await database.raw('select pg_try_advisory_xact_lock(hashtext(?)) as locked', [
          `shopify:${shop}`,
        ]);
        assert.equal(contention.rows[0].locked, false);
        const id = connected.connection_id;
        await service.saveTriggers(scope, id, ['orders/paid']);
        const [record] = await trx('shopify_connections').where({ id });
        assert.deepEqual(record.desired_topics, ['orders/paid']);
        assert.equal((await service.connections(scope))[0].subscribed_topics.length, 3);
        await assert.rejects(service.events({ ...scope, companyId: crypto.randomUUID() }, id), /not found/);
        const raw = Buffer.from('{ "id": 456, "customer": { "id": 8 } }');
        const signature = crypto.createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET).update(raw).digest('base64');
        const headers = {
          'x-shopify-topic': 'orders/paid',
          'x-shopify-shop-domain': shop,
          'x-shopify-webhook-id': crypto.randomUUID(),
        };
        const destination = utils.decrypt(
          record.delivery_token_ciphertext,
          `${scope.companyId}:${scope.ownerId}:${shop}`,
        );
        await service.receive(raw, signature, headers, id, destination);
        assert.equal((await service.receive(raw, signature, headers, id, destination)).duplicate, true);
        assert.equal((await trx('shopify_events').where({ connection_id: id })).length, 1);
        const saved = (await service.events(scope, id)).events[0];
        assert.equal((await service.event(scope, id, saved.id)).payload.id, '456');
        assert.equal((await trx('shopify_data_access_log').where({ connection_id: id })).length, 1);
        async function privacy(topic, data) {
          const raw = Buffer.from(JSON.stringify({ shop_id: 123, shop_domain: shop, ...data }));
          return service.receive(
            raw,
            crypto.createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET).update(raw).digest('base64'),
            { ...headers, 'x-shopify-topic': topic, 'x-shopify-webhook-id': crypto.randomUUID() },
          );
        }
        const req = await privacy('customers/data_request', { customer: { id: 8 } });
        const exported = await service.privacyExport(scope, id, req.request_id);
        assert.equal(exported.events.length, 1);
        assert.equal(exported.events[0].payload.id, '456');
        await service.completePrivacyRequest(scope, id, req.request_id, true);
        assert.equal((await service.privacyRequests(scope, id)).pending, 0);
        await privacy('customers/redact', { orders_to_redact: [456] });
        await service.maintainPrivacy();
        assert.equal((await trx('shopify_events').where({ id: saved.id }).first()).payload_ciphertext, null);
        assert.equal(
          (await trx('shopify_privacy_requests').where({ connection_id: id, status: 'completed' })).length,
          2,
        );
        assert.equal(
          (
            await service.receive(
              raw,
              signature,
              { ...headers, 'x-shopify-webhook-id': crypto.randomUUID() },
              id,
              destination,
            )
          ).ignored,
          true,
        );
        await assert.rejects(
          trx.transaction(async (check) => {
            await check('shopify_events').insert({
              connection_id: id,
              delivery_id: headers['x-shopify-webhook-id'],
              topic: 'orders/paid',
            });
          }),
          (e) => e.code === '23505',
        );
        await assert.rejects(
          trx.transaction(async (check) => {
            await check('shopify_connections').insert({
              ...record,
              id: crypto.randomUUID(),
              scopes: JSON.stringify(record.scopes),
              desired_topics: JSON.stringify(record.desired_topics),
            });
          }),
          (e) => e.code === '23505',
        );
        const wabaId = crypto.randomUUID(),
          phoneId = crypto.randomUUID(),
          templateId = crypto.randomUUID();
        await trx('waba_accounts').insert({ id: wabaId, company_id: scope.companyId, user_id: scope.ownerId });
        await trx('phone_numbers').insert({
          id: phoneId,
          company_id: scope.companyId,
          user_id: scope.ownerId,
          waba_id: wabaId,
          status: 'active',
          phone_number_id: 'fixture-meta',
          display_phone_number: '+14155550000',
        });
        await trx('templates').insert({
          id: templateId,
          company_id: scope.companyId,
          waba_id: wabaId,
          status: 'APPROVED',
          category: 'UTILITY',
          name: 'fixture_paid',
          language: 'en_US',
          components: JSON.stringify([{ type: 'BODY', text: 'Order {{1}} paid' }]),
        });
        let sends = 0;
        const messenger = new ShopifyMessagingService(
          trx,
          async (data) => {
            sends++;
            await trx('messages').insert({
              id: data.messageUUID,
              shopify_job_id: data.shopify_job_id,
              company_id: scope.companyId,
              wamid: 'fixture-sent',
              status: 'sent',
              to_phone: '14155552671',
              content: JSON.stringify(data.template),
            });
            return { wamid: 'fixture-sent' };
          },
          async () => false,
        );
        await messenger.saveRule(scope, id, 'orders/paid', {
          enabled: true,
          phone_number_id: phoneId,
          template_id: templateId,
          consent_confirmed: true,
          consent_attribute: 'soft7_whatsapp_opt_in',
          parameter_mapping: { 'body.1': { field: 'order_number' } },
        });
        const orderRaw = Buffer.from(
          JSON.stringify({
            id: 900,
            customer: { id: 88 },
            order_number: 90,
            phone: '+14155552671',
            note_attributes: [{ name: 'soft7_whatsapp_opt_in', value: 'true' }],
          }),
        );
        const orderSignature = crypto
          .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
          .update(orderRaw)
          .digest('base64');
        for (let i = 0; i < 2; i++)
          await service.receive(
            orderRaw,
            orderSignature,
            { ...headers, 'x-shopify-webhook-id': crypto.randomUUID() },
            id,
            destination,
          );
        assert.equal((await trx('shopify_whatsapp_jobs').where({ connection_id: id })).length, 1);
        const job = await messenger.claim();
        assert.ok(job);
        assert.equal(await messenger.claim(), null);
        await messenger.process(job);
        await messenger.process(job);
        assert.equal(sends, 1);
        assert.equal((await trx('messages').where({ shopify_job_id: job.id })).length, 1);
        const messageRequest = await privacy('customers/data_request', { customer: { id: 88 } });
        assert.equal((await service.privacyExport(scope, id, messageRequest.request_id)).next_section, 'messages');
        assert.equal(
          (await service.privacyExport(scope, id, messageRequest.request_id, undefined, 'messages')).messages.length,
          1,
        );
        await service.completePrivacyRequest(scope, id, messageRequest.request_id, true);
        await privacy('customers/redact', { customer: { id: 88 } });
        const maintained = await service.maintainPrivacy();
        assert.equal(maintained.failed, 0);
        assert.equal((await trx('messages').where({ shopify_job_id: job.id })).length, 0);
        assert.equal((await trx('shopify_whatsapp_jobs').where({ id: job.id }).first()).payload_ciphertext, null);
        stage = 'flow creation';
        const flowService = new ShopifyFlowWebhookService(trx, (_ownerId, action) => action(trx));
        const flowSecret = 'd'.repeat(64);
        const flow = await flowService.create(scope, id, { topic: 'orders/paid', signing_secret: flowSecret });
        const flowToken = new URL(flow.webhook_url).pathname.split('/').pop();
        const flowRaw = Buffer.from(JSON.stringify({ id: 345, customer: { id: 321 } }));
        const flowSignature = crypto.createHmac('sha256', flowSecret).update(flowRaw).digest('base64');
        stage = 'flow delivery';
        await flowService.receive(flow.flow_id, flowToken, flowRaw, flowSignature,
          { ...headers, 'x-shopify-webhook-id': crypto.randomUUID() });
        stage = 'flow status';
        assert.equal((await flowService.status(flow.flow_id, flowToken)).received, 1);
        assert.equal((await trx('shopify_whatsapp_jobs').where({ connection_id: id })).length, 1);
        await trx('shopify_connections').where({ id }).delete();
        assert.equal((await trx('shopify_events').where({ connection_id: id })).length, 0);
        for (const table of [
          'shopify_privacy_requests',
          'shopify_redactions',
          'shopify_data_access_log',
          'shopify_whatsapp_rules',
          'shopify_whatsapp_jobs',
          'shopify_flow_webhooks',
        ])
          assert.equal((await trx(table).where({ connection_id: id })).length, 0);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
    assert.equal(
      (await database.raw('select schema_name from information_schema.schemata where schema_name = ?', [schema])).rows
        .length,
      0,
    );
    console.log(
      'Shopify PostgreSQL checks passed: OAuth, ownership, encrypted events, message jobs, receive-only flow webhooks, deduplication, privacy controls, cascades and fixture rollback.',
    );
  } finally {
    await database.destroy();
  }
})().catch((error) => {
  // Never print database connection strings or upstream request credentials.
  console.error('Shopify PostgreSQL check failed:', error?.code || error?.name || 'Unknown error');
  console.error(JSON.stringify({ stage, location: error?.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 2) }));
  if (error?.code === 'ERR_ASSERTION')
    console.error(
      JSON.stringify({
        actualCode: error.actual?.code,
        actualName: error.actual?.name,
        location: error.stack
          ?.split('\n')
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 2),
      }),
    );
  process.exitCode = 1;
});
