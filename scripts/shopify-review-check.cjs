require('dotenv/config');
const fs = require('node:fs/promises');
const path = require('node:path');
const knex = require('knex');

(async () => {
  const origin = new URL(process.env.SHOPIFY_REDIRECT_URI).origin;
  const report = {
    checked_at: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'unset',
    app_url: origin + '/v1/integrations/shopify/app',
    checks: [],
    limitations: [
      'HTTP checks do not establish browser usability, continuous uptime or Shopify approval.',
      'No valid privacy webhook is sent to a real store by this command.',
      'Provider backup encryption, staff practices and live WhatsApp delivery require separate evidence.',
    ],
  };
  const record = (check, passed, detail) => report.checks.push({ check, passed, detail });
  const probes = [
    [
      'public_app',
      '/v1/integrations/shopify/app',
      { headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' } },
      (r, text) => r.status === 200 && text.includes('id="login-form"'),
    ],
    [
      'public_privacy',
      '/v1/integrations/shopify/privacy',
      { headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' } },
      (r, text) => r.status === 200 && text.includes('Optional WhatsApp order updates'),
    ],
    [
      'unsigned_webhook_rejected',
      '/v1/integrations/shopify/webhook',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      (r) => r.status === 401,
    ],
    ['unauthenticated_owner_api_rejected', '/v1/admin/shopify/connections', {}, (r) => r.status === 401],
  ];
  const results = await Promise.allSettled(
    probes.map(async ([name, uri, options, valid]) => {
      // Deliberately no ngrok-skip-browser-warning header: use an ordinary client.
      const response = await fetch(origin + uri, { ...options, signal: AbortSignal.timeout(12000) });
      const body = await response.text();
      record(name, valid(response, body), {
        status: response.status,
        tunnel_warning: /ERR_NGROK|you are about to visit|ngrok-free.*Visit Site/is.test(body),
        no_store: response.headers.get('cache-control')?.includes('no-store') || false,
      });
    }),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') record(probes[i][0], false, 'Connection failed or timed out.');
  });
  const database = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10000,
  });
  try {
    const tls = await database.raw('select ssl from pg_stat_ssl where pid = pg_backend_pid()');
    record(
      'database_connection_uses_tls',
      tls.rows[0]?.ssl === true,
      tls.rows[0]?.ssl === true
        ? 'TLS active on this connection.'
        : 'TLS not active; confirm a private encrypted network or configure verified TLS before production.',
    );
    for (const table of ['shopify_connections', 'shopify_privacy_requests', 'shopify_whatsapp_jobs'])
      record('table_' + table, await database.schema.hasTable(table), 'Schema existence only.');
    const pending = await database('shopify_privacy_requests').where({ status: 'pending' }).count('* as total').first();
    record('privacy_request_monitoring', true, { pending: Number(pending.total) });
    const connections = await database('shopify_connections')
      .where({ shop_domain: 'my-store-pvotisf6.myshopify.com' })
      .select('status', 'desired_topics', 'subscription_issue');
    record(
      'requested_development_store_connected',
      connections.some((c) => c.status === 'connected'),
      {
        store: 'my-store-pvotisf6.myshopify.com',
        connections: connections.map((c) => ({
          status: c.status,
          topics: c.desired_topics,
          subscription_issue_present: Boolean(c.subscription_issue),
        })),
      },
    );
  } catch {
    record(
      'database_checks_completed',
      false,
      'Database check failed; no credentials or database error contents were recorded.',
    );
  } finally {
    await database.destroy();
  }
  record(
    'production_environment',
    process.env.NODE_ENV === 'production',
    'Current configuration only; no hosting certification.',
  );
  const output = path.resolve('tmp/shopify-review-evidence.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const check of report.checks) console.info(`${check.passed ? 'PASS' : 'NEEDS ACTION'}: ${check.check}`);
  console.info('Evidence written to tmp/shopify-review-evidence.json. No submission or customer message was sent.');
  if (process.argv.includes('--strict') && report.checks.some((c) => !c.passed)) process.exitCode = 1;
})().catch(() => {
  console.error('Review check failed. Check local configuration without sharing secrets.');
  process.exitCode = 1;
});
