// Store API check with normal credential refresh. No dashboard settings or subscription changes.
require('dotenv/config');
require('ts-node/register');
require('tsconfig-paths/register');
const fs = require('node:fs/promises');
const knex = require('knex');
const { ShopifyClient } = require('../src/app/services/shopifyClient.service');
const { load } = require('../tests/shopify-helpers.cjs');
const utils = require('../src/app/utils/shopify');
const { ShopifyService } = load('src/app/services/shopify.service.ts', {
  '@surefy/database': {},
  './shopifyClient.service': { ShopifyClient },
  '../utils/shopify': utils,
  '../utils/shopifyMessaging': require('../src/app/utils/shopifyMessaging'),
});

(async () => {
  const database = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10000,
  });
  const report = {
    checked_at: new Date().toISOString(),
    store: 'my-store-pvotisf6.myshopify.com',
    actions:
      'Shopify shop identity and subscription queries with normal credential refresh if needed; no customer fields, subscription changes or messages.',
    checks: [],
  };
  let stage = 'lookup';
  try {
    const connection = await database('shopify_connections')
      .where({ shop_domain: report.store, status: 'connected' })
      .first();
    if (!connection || !connection.access_token_ciphertext) throw Error('Reconnect the development store.');
    const client = new ShopifyClient();
    stage = 'normal_credentials_and_shop_queries';
    const result = await new ShopifyService(database, client).verifyConnection(
      {
        companyId: connection.company_id,
        ownerId: connection.owner_id,
        userId: connection.owner_id,
      },
      connection.id,
    );
    report.checks.push({ check: 'live_store_identity', passed: result.store_identity_matches });
    report.checks.push({ check: 'granted_scopes', handles: result.granted_scopes });
    report.checks.push({ check: 'live_shop_subscriptions', subscriptions: result.subscriptions });
    report.limitations = [
      'Shop-scoped API results do not establish App Store review status or verify the released app configuration/compliance subscriptions.',
      'This check is not a live order, privacy erasure or WhatsApp delivery demonstration.',
    ];
    console.info('Live Shopify identity and shop-scoped subscription queries completed.');
  } catch (error) {
    report.checks.push({
      check: 'live_shopify_queries',
      passed: false,
      stage,
      detail: error?.statusCode
        ? `Shopify/API status ${error.statusCode}; inspect the normal app connection flow.`
        : 'Check the existing store connection and token expiry; secrets were not recorded.',
    });
    console.info('Live store check needs attention; no settings were changed.');
    process.exitCode = 1;
  } finally {
    await database.destroy();
    await fs.mkdir('tmp', { recursive: true });
    await fs.writeFile('tmp/shopify-live-evidence.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.info('Safe evidence written to tmp/shopify-live-evidence.json.');
  }
})().catch(() => {
  console.error('Live check failed; no secrets are printed.');
  process.exitCode = 1;
});
