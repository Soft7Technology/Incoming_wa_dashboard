const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const GROUP_QUERY = `SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at ASC NULLS LAST, c.id) AS contacts
  FROM contacts c WHERE c.deleted_at IS NULL
  GROUP BY c.company_id, c.user_id, COALESCE(c.phone_number_id::text, ''),
    regexp_replace(c.phone_number, '[^0-9]', '', 'g')
  HAVING count(*) > 1 ORDER BY min(c.id::text)`;

function buildPlan(groups, normalize) {
  const archive = [], review = [];
  for (const { contacts } of groups) {
    const identities = new Set();
    let reason;
    for (const row of contacts) {
      try {
        const identity = normalize(row.phone_number, row.country_code || '');
        // Do not treat missing/invalid country context as proof of the same person.
        if (!identity.is_valid) { reason = 'Unresolved or invalid phone identity'; break; }
        identities.add(JSON.stringify([identity.phone_number, identity.country_code]));
      } catch { reason = 'Phone identity cannot be normalized'; break; }
    }
    if (reason) {
      // Byte-equivalent customer data can be archived without guessing a country.
      // Keep unresolved records requiring any data reconciliation for human review.
      const data = row => JSON.stringify(Object.fromEntries(Object.keys(row).sort()
        .filter(key => !['id', 'created_at', 'updated_at'].includes(key)).map(key => [key, row[key]])));
      if (contacts.every(row => data(row) === data(contacts[0]))) reason = undefined;
    }
    if (!reason && identities.size > 1) reason = 'Same stored digits resolve to different international identities';
    if (reason) {
      review.push({ contact_ids: contacts.map(row => row.id), reason });
      continue;
    }
    const keeper = contacts[0];
    // GROUP_QUERY sorts oldest first. Keep IDs and all original associated data intact.
    for (const row of contacts.slice(1)) {
      archive.push({ keeper_id: keeper.id, contact_id: row.id,
        company_id: row.company_id, user_id: row.user_id, phone_number_id: row.phone_number_id ?? null });
    }
  }
  return { archive, review };
}

function snapshotHash(groups) {
  return createHash('sha256').update(JSON.stringify(groups)).digest('hex');
}

async function writeReport(database, normalize, directory) {
  const groups = (await database.raw(GROUP_QUERY)).rows;
  const plan = buildPlan(groups, normalize);
  const ids = groups.flatMap(group => group.contacts.map(row => row.id));
  // Inventory every real foreign key, rather than assuming only tags/campaigns refer to contacts.
  const references = (await database.raw(`SELECT n.nspname AS schema, t.relname AS table,
      a.attname AS column FROM pg_constraint f
    JOIN pg_class t ON t.oid = f.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = f.conkey[1]
    WHERE f.contype = 'f' AND f.confrelid = 'contacts'::regclass AND array_length(f.conkey, 1) = 1
    ORDER BY n.nspname, t.relname, a.attname`)).rows;
  const associated = {};
  for (const ref of references) {
    associated[`${ref.schema}.${ref.table}.${ref.column}`] = ids.length
      ? await database.withSchema(ref.schema).table(ref.table).whereIn(ref.column, ids).select('*') : [];
  }
  const report = {
    version: 1, created_at: new Date().toISOString(), snapshot_hash: snapshotHash(groups),
    policy: 'Keep oldest contact active; soft-archive additional copies. No rows, notes, tags, lists, campaigns or reminders are deleted or moved. Associated data remains on its original contact ID.',
    summary: { duplicate_groups: groups.length, copies_to_archive: plan.archive.length,
      groups_requiring_review: plan.review.length, related_records: Object.fromEntries(Object.entries(associated).map(([key, rows]) => [key, rows.length])) },
    plan, original_contacts: groups, associated_records: associated,
  };
  fs.mkdirSync(directory, { recursive: true });
  const reportPath = path.join(directory, 'contact-duplicate-repair.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return { report, reportPath };
}

async function applyReport(database, normalize, reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.version !== 1 || !report.original_contacts || report.snapshot_hash !== snapshotHash(report.original_contacts)) {
    throw new Error('Invalid or modified repair snapshot; generate a new report');
  }
  const plan = buildPlan(report.original_contacts, normalize);
  if (plan.review.length) throw new Error('Report contains unresolved identities. Review these groups before applying; no records were changed.');
  return database.transaction(async trx => {
    await trx.raw("SET LOCAL lock_timeout = '5s'");
    await trx.raw('LOCK TABLE contacts IN SHARE ROW EXCLUSIVE MODE');
    const current = (await trx.raw(GROUP_QUERY)).rows;
    if (snapshotHash(current) !== report.snapshot_hash) throw new Error('Contacts changed since the report. Generate a fresh report before applying.');
    const archivedAt = new Date().toISOString();
    const ids = plan.archive.map(row => row.contact_id);
    // Write the recovery manifest before the database update; failure here cannot change contacts.
    const receiptPath = path.join(path.dirname(reportPath), 'archive-receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify({ status: 'prepared', archived_at: archivedAt,
      report: path.basename(reportPath), snapshot_hash: report.snapshot_hash, archived_contact_ids: ids,
      plan: plan.archive }, null, 2), { flag: 'wx', mode: 0o600 });
    if (ids.length) {
      const updated = await trx('contacts').whereIn('id', ids).whereNull('deleted_at')
        .update({ deleted_at: archivedAt }).returning('id');
      if (updated.length !== ids.length) throw new Error('Archive count changed unexpectedly; transaction rolled back');
    }
    // Verify the exact index key before committing the archive operation.
    const remaining = (await trx.raw(GROUP_QUERY)).rows;
    if (remaining.length) throw new Error('Duplicate identities remain; transaction rolled back');
    return { archived: ids.length, archived_at: archivedAt, receiptPath };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args[0] === '--apply';
  if (args.length && !apply && args[0] !== '--dry-run') throw new Error('Usage: node scripts/repair-contact-duplicates.cjs [--dry-run | --apply <report.json>]');
  if (apply && args.length !== 2) throw new Error('--apply requires the reviewed report path');
  require('ts-node/register');
  const config = require('../library/surefy/src/config/knex.config').default[process.env.NODE_ENV || 'development'];
  if (!config) throw new Error('Unsupported database environment');
  const database = require('knex')({ ...config, pool: { min: 0, max: 2 }, acquireConnectionTimeout: 10000 });
  const normalize = require('../src/app/utils/importPhone').parseStoredContactPhone;
  try {
    if (apply) {
      const result = await applyReport(database, normalize, path.resolve(args[1]));
      // This receipt confirms the transaction actually committed.
      const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
      fs.writeFileSync(result.receiptPath, JSON.stringify({ ...receipt, status: 'committed' }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(result, null, 2));
    } else {
      const directory = path.resolve('backups', `contact-repair-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
      const { report, reportPath } = await writeReport(database, normalize, directory);
      console.log(JSON.stringify({ dry_run: true, ...report.summary, report_path: reportPath,
        data_changed: false, policy: report.policy }, null, 2));
    }
  } finally { await database.destroy(); }
}

module.exports = { buildPlan, snapshotHash, writeReport, applyReport };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
