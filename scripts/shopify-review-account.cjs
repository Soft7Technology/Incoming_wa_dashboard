// Dedicated empty development tenant. Never reuses an existing merchant or staff account.
require('dotenv/config');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const knex = require('knex');

(async () => {
  if (process.env.NODE_ENV !== 'development')
    throw Error('Development only. Provision production review access through the normal company onboarding process.');
  const output = path.resolve('tmp/shopify-review-login.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  // Fail before any database mutation if credentials already exist; never rotate them implicitly.
  const handle = await fs.open(output, 'wx', 0o600);
  let created = false;
  const database = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10000,
  });
  try {
    const companyId = crypto.randomUUID(),
      userId = crypto.randomUUID();
    const email = `shopify-review-${crypto.randomBytes(6).toString('hex')}@example.invalid`;
    const password = crypto.randomBytes(24).toString('base64url');
    const origin = new URL(process.env.SHOPIFY_REDIRECT_URI).origin;
    const credentials = {
      environment: 'development',
      app_url: origin + '/v1/integrations/shopify/app',
      email,
      password,
      login_domain: 'localhost',
      company_id: companyId,
      user_id: userId,
      created_at: new Date().toISOString(),
      purpose:
        'Dedicated empty reviewer tenant. No production merchant access, WhatsApp sender or Shopify store preconfigured.',
      share_only:
        'Copy login fields into Shopify private testing instructions after deployment verification; do not publish this file.',
    };
    await handle.writeFile(JSON.stringify(credentials, null, 2) + '\n');
    const hash = await bcrypt.hash(password, 12);
    await database.transaction(async (trx) => {
      await trx('companies').insert({ id: companyId, name: 'Soft7 Shopify Review', email, status: 'active' });
      await trx('users').insert({
        id: userId,
        company_id: companyId,
        name: 'Shopify Reviewer',
        email,
        password: hash,
        role: 'user',
        status: 'active',
      });
    });
    created = true;
    const response = await fetch('http://localhost:8001/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email, password, domain_name: 'localhost' }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    const token = body.data?.token || body.token;
    if (!response.ok || !token) throw Error('Account created; login needs attention.');
    const connections = await fetch('http://localhost:8001/v1/admin/shopify/connections', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    const scoped = await connections.json();
    if (!connections.ok || scoped.data?.connections?.length !== 0) throw Error('Review tenant verification failed.');
    console.info('Dedicated development reviewer login and empty Shopify tenant verified.');
    console.info(
      'Credentials saved only in ignored tmp/shopify-review-login.json. No email or customer message was sent.',
    );
  } finally {
    await handle.close();
    if (!created) await fs.rm(output, { force: true });
    await database.destroy();
  }
})().catch((error) => {
  console.error(
    error?.code === 'EEXIST'
      ? 'Review credentials already exist; no account was created or password changed.'
      : 'Review account setup needs attention. Inspect the local credential file if present; no secrets are printed.',
  );
  process.exitCode = 1;
});
