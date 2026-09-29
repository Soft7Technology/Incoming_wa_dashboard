require('dotenv').config();
require('ts-node/register');
const { Client } = require('pg');
const { auditContactPhones } = require('../src/app/utils/contactPhoneAudit');
const client = new Client(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 30000 }
  : { host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
      connectionTimeoutMillis: 5000, statement_timeout: 30000 });
(async () => {
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const columns = await client.query("SELECT column_name, column_default FROM information_schema.columns WHERE table_name='contacts' AND column_name IN ('country_code','phone_number','phone_number_id')");
    const indexes = await client.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='contacts'");
    console.log(JSON.stringify({ columns: columns.rows, indexes: indexes.rows }, null, 2));
    const { rows } = await client.query('SELECT id, company_id, user_id, phone_number_id, phone_number, country_code, deleted_at FROM contacts');
    const { updates, issues } = auditContactPhones(rows);
    const reasons = {};
    for (const issue of issues) { const reason = issue.reason.startsWith('Duplicate') ? 'Duplicate normalized identity' : issue.reason; reasons[reason] = (reasons[reason] || 0) + 1; }
    console.log(JSON.stringify({ total: rows.length, normalizable: updates.length, issueCount: issues.length, reasons, sample: issues.slice(0, 5) }, null, 2));
    if (process.argv[2]) require('fs').writeFileSync(process.argv[2], JSON.stringify({ total: rows.length, reasons, issues }, null, 2));
    await client.query('ROLLBACK');
  } catch (error) {
    console.error('Contact phone audit failed:', error.code || error.message);
    process.exitCode = 1;
  } finally { await client.end(); }
})();
