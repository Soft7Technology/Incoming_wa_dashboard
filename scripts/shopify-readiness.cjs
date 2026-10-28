require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const problems = [],
  notes = [];
for (const key of [
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_REDIRECT_URI',
  'SHOPIFY_FRONTEND_URL',
  'SHOPIFY_TOKEN_ENCRYPTION_KEY',
  'SHOPIFY_PRIVACY_CONTROLLER',
  'SHOPIFY_PRIVACY_EMAIL',
])
  if (!process.env[key]?.trim()) problems.push(`Set ${key}.`);
try {
  const callback = new URL(process.env.SHOPIFY_REDIRECT_URI);
  if (
    callback.protocol !== 'https:' ||
    callback.pathname !== '/v1/integrations/shopify/callback' ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  )
    problems.push('Use an HTTPS callback ending in /v1/integrations/shopify/callback.');
  if (/ngrok|trycloudflare/i.test(callback.hostname))
    notes.push(
      'Tunnel hosting: remove any browser warning, and keep this exact hostname and backend available throughout review. Persistent production hosting is still unverified.',
    );
  const frontend = new URL(process.env.SHOPIFY_FRONTEND_URL);
  if (frontend.protocol !== 'https:' || frontend.username || frontend.password || frontend.search || frontend.hash)
    problems.push('SHOPIFY_FRONTEND_URL must be an HTTPS dashboard URL.');
  console.info('App URL:', callback.origin + '/v1/integrations/shopify/app');
  console.info('Privacy URL:', callback.origin + '/v1/integrations/shopify/privacy');
  console.info('Compliance webhook URL:', callback.origin + '/v1/integrations/shopify/webhook');
} catch {
  problems.push('Set valid Shopify callback and frontend URLs.');
}
try {
  const key = Buffer.from(process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32)
    problems.push('Configure a stable 32-byte base64 Shopify encryption key. Do not rotate an existing key.');
  else crypto.createHmac('sha256', key).update('configuration-check').digest();
} catch {
  problems.push('Shopify encryption key is invalid.');
}
if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(process.env.SHOPIFY_PRIVACY_EMAIL || ''))
  problems.push('Configure a valid public SHOPIFY_PRIVACY_EMAIL.');
const days = Number(process.env.SHOPIFY_EVENT_RETENTION_DAYS || 30);
if (!Number.isInteger(days) || days < 1 || days > 30) problems.push('Retention must be an integer from 1 to 30 days.');
for (const file of [
  'dist/src/server.js',
  'dist/src/web/shopify/index.html',
  'dist/src/database/migrations/20261017000001_shopify_privacy.js',
  'dist/src/database/migrations/20261017000002_shopify_whatsapp.js',
  'dist/src/database/migrations/20261017000003_shopify_flow_webhooks.js',
  'dist/src/scripts/shopifyMessageWorker.js',
])
  if (!fs.existsSync(path.resolve(__dirname, '..', file))) problems.push(`Run npm run build; missing ${file}.`);
if (process.env.NODE_ENV !== 'production')
  notes.push('The configured environment is development; this is not a production deployment.');
notes.push(
  'Verify all three compliance-topic subscriptions in Shopify, live OAuth, database/backup encryption and retention, and staff/security policies before submitting.',
);
notes.push(
  'Order messaging additionally needs Phone-field access, an approved utility template, checkout consent capture and a running Shopify message worker.',
);
for (const message of notes) console.info('NOTE:', message);
for (const message of problems) console.error('REQUIRED:', message);
console.info(
  problems.length
    ? 'Local configuration needs attention.'
    : 'Local Shopify configuration checks passed. Hosting and Shopify dashboard approval are not verified by this check.',
);
process.exitCode = problems.length ? 1 : 0;
