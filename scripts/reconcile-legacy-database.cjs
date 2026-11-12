// Explicit, backed-up reconciliation for databases imported without complete Knex history.
// Never runs at application startup. Review --dry-run output, rehearse on a restored
// backup, then --apply that exact report. Historical intermediate phone formats are
// reconciled to the final unresolved-safe format instead of inventing country codes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const migrationDir = path.join(root, 'src/database/migrations');
const historical = [
  '20260920000001_scope_contact_identity_to_owner',
  '20260921000001_create_client_api_keys', '20260921000002_rename_client_api_keys_to_user_api_keys',
  '20260921000003_remove_user_api_key_name', '20260921000004_one_active_api_key_per_user',
  '20260921000005_store_encrypted_user_api_key', '20260923000001_add_subscription_trial_days',
  '20260923000002_index_user_plan_assignment', '20260923000003_backfill_team_seat_usage',
  '20260923000004_index_activity_logs', '20260924000001_expand_template_name',
  '20260924000002_company_payment_gateways', '20260926000001_normalize_contact_phone_identity',
  '20260928000001_link_payment_user_plans', '20260928000002_contact_campaign_opt_out',
  '20260928000003_index_contact_opt_out', '20260929000001_create_reminders',
  '20260929000002_reminder_parameter_mapping', '20260930000001_contacts_international_phone',
  '20260930000002_restore_split_contact_phone', '20260930000003_allow_unresolved_contact_phones',
  '20260930000004_template_waba_identity', '20260930000005_superadmin_audit',
  '20260930000006_campaign_send_attempts', '20261003000001_add_contact_source',
  '20261008000001_add_message_inbox_read_at', '20261008000003_index_contact_status_queries',
  '20261008000004_index_contact_assignees', '20261012000001_allow_unsupported_messages',
  '20261028000001_correct_manual_credit_types',
].map(name => name + '.ts');
const requiredColumns = {
  user_api_keys: 'id user_id company_id key_hash key_prefix created_at revoked_at api_key_encrypted',
  subscription_plans: 'id billing_cycle trial_days', user_plans: 'id user_id billing_cycle active usage',
  company_payment_gateways: 'id company_id provider mode credentials_encrypted display_name active created_at',
  company_payment_orders: 'id company_id user_id gateway_id idempotency_key request_hash amount_paise currency is_test status provider_order_id checkout paid_at created_at updated_at user_plan_id fulfilled_at',
  contacts: 'id company_id user_id phone_number_id phone_number country_code is_valid deleted_at is_opted_out source assigned_to',
  phone_numbers: 'id user_id company_id waba_id opt_in_keywords opt_out_keywords',
  reminders: 'id company_id user_id contact_id phone_number_id template_id name frequency timezone local_datetime variables status last_attempt_id next_send_at created_at updated_at parameter_mapping media_uploads',
  reminder_attempts: 'id reminder_id scheduled_at attempted_at finished_at snapshot status wamid failure_reason',
  reminder_delivery_events: 'id wamid status meta_timestamp error received_at',
  superadmin_audit_logs: 'id actor_id company_id target_id action reason changes created_at',
  campaign_send_attempts: 'company_id campaign_id phone_number_id recipient attempted_at',
  messages: 'id company_id user_id type inbox_read_at direction campaign_id phone_number_id to_phone created_at',
  templates: 'id company_id user_id waba_id template_id name language status components deleted_at synced_at updated_at created_at',
};
const indexDefinitions = {
  contacts_owner_phone_unique: ['contacts', true, "(company_id, user_id, (COALESCE(phone_number_id::text, '')), phone_number) WHERE deleted_at IS NULL"],
  contacts_owner_page_idx: ['contacts', false, '(user_id, company_id, created_at DESC, id DESC) WHERE deleted_at IS NULL'],
  waba_accounts_owner_idx: ['waba_accounts', false, '(user_id, company_id) WHERE deleted_at IS NULL'],
  phone_numbers_owner_idx: ['phone_numbers', false, '(user_id, company_id, waba_id) WHERE deleted_at IS NULL'],
  user_api_keys_one_active_per_user: ['user_api_keys', true, '(user_id) WHERE revoked_at IS NULL'],
  user_plans_one_active_per_user: ['user_plans', true, '(user_id) WHERE active = true'],
  user_plans_user_billing_cycle_idx: ['user_plans', false, '(user_id, billing_cycle)'],
  activity_logs_company_created_idx: ['activity_logs', false, '(company_id, created_at DESC, id DESC) WHERE deleted_at IS NULL'],
  activity_logs_user_created_idx: ['activity_logs', false, '(user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL'],
  company_payment_gateway_active: ['company_payment_gateways', true, '(company_id, mode) WHERE active = true'],
  contacts_campaign_opt_out_idx: ['contacts', false, '(company_id, user_id, phone_number_id, country_code, phone_number) WHERE is_opted_out = true'],
  templates_waba_name_language_active_unique: ['templates', true, '(company_id, waba_id, name, language) WHERE deleted_at IS NULL'],
  credit_superadmin_request_unique: ['credit_transactions', true, "(company_id, reference_id) WHERE reference_type = 'superadmin_manual'"],
  contacts_account_status_created_idx: ['contacts', false, '(user_id, company_id, status, created_at DESC, id ASC) WHERE deleted_at IS NULL'],
  contacts_phone_status_created_idx: ['contacts', false, '(user_id, company_id, phone_number_id, status, created_at DESC, id ASC) WHERE deleted_at IS NULL'],
  contacts_active_assigned_to_idx: ['contacts', false, 'USING GIN (assigned_to) WHERE deleted_at IS NULL'],
};
const contactColumns = ['id', 'company_id', 'user_id', 'phone_number_id', 'phone_number', 'country_code', 'is_valid', 'deleted_at', 'created_at', 'is_opted_out'];

function canonicalPhone(row, parseImportedPhone) {
  try {
    const parsed = parseImportedPhone(row.phone_number, row.country_code || '', Boolean(row.country_code));
    return { phone_number: '+' + parsed.country_code + parsed.phone_number, country_code: parsed.country_code,
      is_valid: row.is_valid !== false };
  } catch {
    // Preserve the supplied digits; neither infer a country nor manufacture a number.
    const raw = String(row.phone_number).trim();
    if (!/^[+\d\s().-]+$/.test(raw)) throw new Error('Phone needs manual review: ' + row.id);
    let digits = raw.replace(/[^0-9]/g, '');
    if (!raw.startsWith('+') && digits.startsWith('00')) digits = digits.slice(2);
    // Historical pasted numbers can exceed the import limit. Preserve them within
    // the existing varchar(50), but never make them eligible for sending.
    if (!/^\d{1,49}$/.test(digits)) throw new Error('Phone length needs manual review: ' + row.id);
    return { phone_number: '+' + digits, country_code: null, is_valid: false };
  }
}
function contactPlan(rows, parseImportedPhone) {
  const normalized = rows.map(row => ({ ...row, ...canonicalPhone(row, parseImportedPhone) }));
  const seen = new Map(), archive = [], groups = new Set();
  for (const row of normalized) {
    if (row.deleted_at) continue;
    const key = JSON.stringify([row.company_id, row.user_id, row.phone_number_id || null, row.phone_number]);
    const keeper = seen.get(key);
    if (keeper) {
      groups.add(key); archive.push({ contact_id: row.id, keeper_id: keeper.id });
      // Suppression must survive choosing a single active copy.
      if (row.is_opted_out) keeper.is_opted_out = true;
    } else seen.set(key, row);
  }
  const archived = new Set(archive.map(x => x.contact_id));
  const changes = [];
  normalized.forEach((row, i) => {
    const before = rows[i];
    if (archived.has(row.id) || ['phone_number', 'country_code', 'is_valid', 'is_opted_out'].some(k => row[k] !== before[k])) {
      changes.push({ id: row.id, phone_number: row.phone_number, country_code: row.country_code,
        is_valid: row.is_valid, is_opted_out: row.is_opted_out, archive: archived.has(row.id) });
    }
  });
  return { changes, archive, summary: { total: rows.length, changed: changes.length,
    duplicate_groups: groups.size, copies_to_archive: archive.length,
    unresolved: normalized.filter(r => r.country_code === null).length,
    legacy_invalid_length: normalized.filter(r => !/^[+]\d{4,15}$/.test(r.phone_number)).length } };
}
function templatePlan(rows) {
  const seen = new Map(), archive = [], groups = new Set();
  for (const row of rows) {
    const key = JSON.stringify([row.company_id, row.waba_id, row.name, row.language]);
    const keeper = seen.get(key);
    if (keeper) {
      if (!row.template_id || row.template_id !== keeper.template_id) throw new Error('Conflicting Meta template IDs need review: ' + row.id);
      archive.push({ template_id: row.id, keeper_id: keeper.id }); groups.add(key);
    } else seen.set(key, row);
  }
  return { archive, summary: { duplicate_groups: groups.size, copies_to_archive: archive.length } };
}
async function catalog(db) {
  return {
    columns: (await db.raw("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
    constraints: (await db.raw("SELECT t.relname AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY t.relname,c.conname")).rows,
    indexes: (await db.raw("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows,
    migrations: await db('knex_migrations').orderBy('name'),
  };
}
function verifyExistingSchema(schema) {
  for (const [table, columns] of Object.entries(requiredColumns)) for (const column of columns.split(' '))
    assert.ok(schema.columns.some(c => c.table_name === table && c.column_name === column), `Missing prerequisite ${table}.${column}`);
  assert.ok(!schema.columns.some(c => c.table_name === 'client_api_keys'), 'Both API-key tables need manual reconciliation');
  assert.ok(!schema.columns.some(c => c.table_name === 'user_api_keys' && c.column_name === 'name'), 'API-key labels need explicit review');
  const check = (table, terms) => assert.ok(schema.constraints.some(c => c.table_name === table && terms.every(s => c.definition.includes(s))), `Missing prerequisite constraint: ${table} ${terms}`);
  for (const table of ['user_api_keys', 'company_payment_gateways', 'company_payment_orders', 'reminders', 'reminder_attempts', 'reminder_delivery_events', 'superadmin_audit_logs']) check(table, ['PRIMARY KEY', '(id)']);
  check('user_api_keys', ['UNIQUE', 'key_hash']);
  check('user_api_keys', ['FOREIGN KEY (user_id)', 'REFERENCES users(id)']);
  check('user_api_keys', ['FOREIGN KEY (company_id)', 'REFERENCES companies(id)']);
  check('subscription_plans', ['CHECK', 'trial_days', 'Free', '3', '7', '10']);
  check('company_payment_orders', ['UNIQUE', 'company_id, user_id, idempotency_key']);
  check('company_payment_orders', ['UNIQUE', 'gateway_id, provider_order_id']);
  check('company_payment_orders', ['UNIQUE', 'user_plan_id']);
  check('company_payment_orders', ['FOREIGN KEY (gateway_id)', 'REFERENCES company_payment_gateways(id)']);
  check('company_payment_orders', ['FOREIGN KEY (user_plan_id)', 'REFERENCES user_plans(id)']);
  check('company_payment_orders', ['CHECK', 'amount_paise >= 100']);
  check('reminder_attempts', ['UNIQUE', 'reminder_id, scheduled_at']);
  check('reminder_delivery_events', ['UNIQUE', 'wamid, status, meta_timestamp']);
  check('campaign_send_attempts', ['PRIMARY KEY', 'company_id, campaign_id, phone_number_id, recipient']);
  check('contacts', ['CHECK', 'source', 'import', 'manually', 'whatsApp']);
  check('messages', ['CHECK', 'type', 'reaction', 'unsupported']);
}
async function snapshot(db) {
  const schema = await catalog(db); verifyExistingSchema(schema);
  const rows = await db('contacts').select(contactColumns).orderByRaw('created_at ASC NULLS LAST, id ASC');
  const templates = (await db.raw(`SELECT t.id,t.company_id,t.user_id,t.waba_id,t.template_id,t.name,t.language,t.status,t.components,t.synced_at,t.updated_at
    FROM templates t LEFT JOIN waba_accounts w ON w.id=t.waba_id
    WHERE t.deleted_at IS NULL ORDER BY (t.user_id=w.user_id) DESC NULLS LAST,
    t.synced_at DESC NULLS LAST,t.updated_at DESC NULLS LAST,t.created_at DESC NULLS LAST,t.id`)).rows;
  return { schema, rows, templates };
}
function sourceHashes() { return Object.fromEntries(historical.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(migrationDir, name))).digest('hex')])); }
function normalizeIndex(sql) {
  return sql.toLowerCase().replace(/public\./g, '').replace(/::(?:text|character varying)/g, '')
    .replace(/using btree/g, '').replace(/\basc\b/g, '').replace(/[\s()"']/g, '');
}
async function ensureIndexes(db) {
  const existing = (await catalog(db)).indexes;
  for (const [name, [table, unique, definition]] of Object.entries(indexDefinitions)) {
    const sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} ${definition}`;
    const found = existing.find(x => x.indexname === name);
    if (found) assert.equal(normalizeIndex(found.indexdef), normalizeIndex(sql), 'Unexpected index definition: ' + name);
    else await db.raw(sql);
  }
}
async function repair(db, plan) {
  const now = new Date().toISOString();
  await db.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_digits_check');
  await db.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_company_id_phone_number_unique');
  await db.raw('DROP INDEX IF EXISTS contacts_owner_phone_unique');
  await db.raw('ALTER TABLE contacts ALTER COLUMN country_code DROP NOT NULL');
  await db.raw('ALTER TABLE contacts ALTER COLUMN country_code DROP DEFAULT');
  for (let offset = 0; offset < plan.contacts.changes.length; offset += 2000) {
    await db.raw(`UPDATE contacts c SET phone_number=n.phone_number,country_code=n.country_code,is_valid=n.is_valid,
      is_opted_out=n.is_opted_out,deleted_at=CASE WHEN n.archive THEN ?::timestamptz ELSE c.deleted_at END
      FROM jsonb_to_recordset(?::jsonb) AS n(id uuid,phone_number text,country_code text,is_valid boolean,is_opted_out boolean,archive boolean)
      WHERE c.id=n.id`, [now, JSON.stringify(plan.contacts.changes.slice(offset, offset + 2000))]);
  }
  await require(path.join(migrationDir, '20261112000002_preserve_legacy_unresolved_contacts.ts')).up(db);
  if (plan.templates.archive.length) await db('templates').whereIn('id', plan.templates.archive.map(x => x.template_id)).whereNull('deleted_at').update({ deleted_at: now });
  await db.raw('ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_company_id_name_language_unique');
  await db.raw('ALTER TABLE templates ALTER COLUMN name TYPE text');
  // Apply missing data effects explicitly; never replace history with unverified rows.
  const keyDuplicates = await db.raw('SELECT 1 FROM user_api_keys WHERE revoked_at IS NULL GROUP BY user_id HAVING count(*)>1 LIMIT 1');
  assert.equal(keyDuplicates.rows.length, 0, 'Multiple active API keys need explicit review before revocation');
  await db('subscription_plans').where({ billing_cycle: 'Free' }).whereNull('trial_days').update({ trial_days: 3 });
  await require(path.join(migrationDir, '20260923000003_backfill_team_seat_usage.ts')).up(db);
  await require(path.join(migrationDir, '20261028000001_correct_manual_credit_types.ts')).up(db);
  await db.raw(`INSERT INTO campaign_send_attempts(company_id,campaign_id,phone_number_id,recipient,attempted_at)
    SELECT company_id,campaign_id,phone_number_id,regexp_replace(to_phone,'[^0-9]','','g'),MIN(created_at)
    FROM messages WHERE direction='outbound' AND campaign_id IS NOT NULL AND company_id IS NOT NULL AND phone_number_id IS NOT NULL AND to_phone IS NOT NULL
    GROUP BY company_id,campaign_id,phone_number_id,regexp_replace(to_phone,'[^0-9]','','g') ON CONFLICT DO NOTHING`);
  await ensureIndexes(db);
  const schema = await catalog(db); verifyExistingSchema(schema);
  // A baseline records verified final state, not fictitious execution of obsolete
  // intermediate migrations. Batch zero keeps it out of a routine latest rollback.
  const completed = new Set(schema.migrations.map(x => x.name));
  const names = historical.filter(name => !completed.has(name));
  if (names.length) await db('knex_migrations').insert(names.map(name => ({ name, batch: 0, migration_time: new Date() })));
  return { baseline_entries: names, contacts_changed: plan.contacts.changes.length,
    contacts_archived: plan.contacts.archive.length, templates_archived: plan.templates.archive.length, archived_at: now };
}
async function main() {
  const args = process.argv.slice(2); const mode = args[0];
  assert.ok(['--dry-run', '--apply'].includes(mode), 'Use --dry-run <report.json> or --apply <report.json> [--connection-file <json>]');
  const reportPath = path.resolve(args[1]);
  require('ts-node/register');
  const cfg = require('../library/surefy/src/config/knex.config').default[process.env.NODE_ENV || 'development'];
  const idx = args.indexOf('--connection-file');
  const connection = idx >= 0 ? JSON.parse(fs.readFileSync(path.resolve(args[idx + 1]))).connectionString : cfg.connection;
  const db = require('knex')({ ...cfg, connection, pool: { min: 0, max: 2 }, acquireConnectionTimeout: 15000 });
  const { parseImportedPhone } = require('../src/app/utils/importPhone');
  const target = new URL(typeof connection === 'string' ? connection : connection.connectionString);
  const targetId = { host: target.hostname, port: target.port || '5432', database: target.pathname.slice(1) };
  try {
    if (mode === '--dry-run') {
      console.log('Reading schema and contact identities (read only)...');
      const data = await db.transaction(async trx => { await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); return snapshot(trx); });
      const plan = { contacts: contactPlan(data.rows, parseImportedPhone), templates: templatePlan(data.templates) };
      const completed = new Set(data.schema.migrations.map(x => x.name));
      const report = { version: 1, created_at: new Date().toISOString(), target: targetId,
        source_hashes: sourceHashes(), snapshot_hash: hash(data), policy: 'Preserve unresolved digits as invalid. Keep oldest contact active; prefer WABA owner then most recently synced template. Soft-archive duplicate rows, retain all original references. Reconcile verified final schema; preserve newer columns and allowed message/source types.',
        baseline_entries: historical.filter(n => !completed.has(n)), summary: { contacts: plan.contacts.summary, templates: plan.templates.summary }, plan };
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ target: targetId, ...report.summary, baseline_entries: report.baseline_entries.length, report_path: reportPath, data_changed: false }, null, 2));
    } else {
      const report = JSON.parse(fs.readFileSync(reportPath));
      assert.equal(report.version, 1); assert.deepEqual(report.target, targetId); assert.deepEqual(report.source_hashes, sourceHashes());
      const receiptPath = reportPath.replace(/\.json$/, '') + '-receipt.json';
      assert.ok(!fs.existsSync(receiptPath), 'Receipt exists; verify outcome before retrying');
      console.log('Validating snapshot under transaction locks...');
      const result = await db.transaction(async trx => {
        await trx.raw("SET LOCAL lock_timeout='5s'"); await trx.raw("SET LOCAL statement_timeout='10min'");
        await trx.raw('LOCK TABLE knex_migrations_lock IN EXCLUSIVE MODE');
        const lock = await trx('knex_migrations_lock').first(); assert.equal(Number(lock.is_locked), 0, 'Another migration is active');
        await trx('knex_migrations_lock').update({ is_locked: 1 });
        await trx.raw('LOCK TABLE contacts,templates,user_api_keys,user_plans,subscription_plans,campaign_send_attempts,credit_transactions IN SHARE ROW EXCLUSIVE MODE');
        const data = await snapshot(trx); assert.equal(hash(data), report.snapshot_hash, 'Database changed; generate a fresh dry-run report');
        const plan = { contacts: contactPlan(data.rows, parseImportedPhone), templates: templatePlan(data.templates) };
        assert.deepEqual(plan, report.plan, 'Repair plan does not match snapshot');
        const changedIds = new Set(plan.contacts.changes.map(row => row.id));
        const manualTopups = require(path.join(migrationDir, '20261028000001_correct_manual_credit_types.ts')).manualTopups;
        const recovery = {
          original_contact_fields: data.rows.filter(row => changedIds.has(row.id)),
          archived_template_ids: plan.templates.archive.map(row => row.template_id),
          active_plan_usage: await trx('user_plans').where({ active: true }).select('id', 'usage'),
          manual_credit_values: await manualTopups(trx).select('id', 'type', 'meta_data'),
          schema_before: data.schema,
        };
        fs.writeFileSync(receiptPath, JSON.stringify({ status: 'prepared', target: targetId, report: reportPath,
          policy: report.policy, summary: report.summary, recovery }), { flag: 'wx', mode: 0o600 });
        const beforeContacts = Number((await trx('contacts').count('* as count').first()).count);
        const beforeTemplates = Number((await trx('templates').count('* as count').first()).count);
        const result = await repair(trx, plan);
        assert.equal(Number((await trx('contacts').count('* as count').first()).count), beforeContacts);
        assert.equal(Number((await trx('templates').count('* as count').first()).count), beforeTemplates);
        await trx('knex_migrations_lock').update({ is_locked: 0 });
        return result;
      });
      const prepared = JSON.parse(fs.readFileSync(receiptPath));
      fs.writeFileSync(receiptPath, JSON.stringify({ ...prepared, status: 'committed', ...result }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ status: 'committed', ...result, receipt_path: receiptPath }, null, 2));
    }
  } finally { await db.destroy(); }
}
module.exports = { canonicalPhone, contactPlan, templatePlan, normalizeIndex };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
