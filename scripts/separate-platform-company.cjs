const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const SUPERADMIN_EMAIL = 'soft7.in@gmail.com';
const ADMIN_EMAIL = 'soft7admin@gmail.com';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

/** Preserve all company/user/ledger/domain rows plus the superadmin's existing business records. */
async function preservationSnapshot(trx, userId, companyId, legacyCompanyId) {
  const { schema } = (await trx.raw('select current_schema() as schema')).rows[0];
  const tables = await trx('information_schema.columns as c')
    .join('information_schema.tables as t', function () {
      this.on('t.table_schema', 'c.table_schema').andOn('t.table_name', 'c.table_name');
    }).where({ 'c.table_schema': schema, 'c.column_name': 'company_id', 't.table_type': 'BASE TABLE' })
    .select('c.table_name').orderBy('c.table_name');
  const snapshot = {};
  const ownedTables = new Set((await trx('information_schema.columns')
    .where({ table_schema: schema, column_name: 'user_id' }).select('table_name')).map(row => row.table_name));
  for (const table of ['companies', ...tables.map(row => row.table_name)]) {
    const query = trx(`${table} as record`);
    if (table === 'companies') query.whereNot('id', companyId);
    else if (['users', 'credit_transactions', 'company_domains'].includes(table))
      query.where(builder => builder.whereNot('company_id', companyId).orWhereNull('company_id'));
    else {
      query.where('company_id', legacyCompanyId);
      if (ownedTables.has(table)) query.where('user_id', userId);
    }
    if (table === 'users') query.whereNot('id', userId);
    snapshot[table] = await query.select(trx.raw(`count(*)::text as count,
      md5(coalesce(string_agg(md5(to_jsonb(record)::text), '' order by md5(to_jsonb(record)::text)), '')) as fingerprint`)).first();
  }
  return snapshot;
}

async function separatePlatformCompany(db, options = {}) {
  if (options.companyId !== undefined && !uuid(options.companyId)) throw Error('companyId must be a UUID');
  const rehearsal = {};
  let rehearsalResult;
  const result = await db.transaction(async trx => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await trx.raw("SET LOCAL statement_timeout = '30s'");
    await trx.raw("SET LOCAL lock_timeout = '5s'");
    await trx.raw("select pg_advisory_xact_lock(hashtext('soft7_platform_company_separation'))");
    const triggers = await trx.raw(`select tgname from pg_trigger where tgrelid in ('users'::regclass, 'companies'::regclass)
      and not tgisinternal and tgenabled <> 'D'`);
    assert.equal(triggers.rows.length, 0, 'Review custom user/company triggers before separating organizations');
    const accounts = await trx('users').whereIn(trx.raw('lower(email)'), [SUPERADMIN_EMAIL, ADMIN_EMAIL])
      .whereNull('deleted_at').orderBy('id').forUpdate();
    const user = accounts.find(row => row.email.toLowerCase() === SUPERADMIN_EMAIL);
    const admin = accounts.find(row => row.email.toLowerCase() === ADMIN_EMAIL);
    assert.ok(user?.role === 'superadmin' && user.status === 'active', 'Active Soft7 superadmin not found');
    assert.ok(admin?.role === 'admin' && admin.company_id, 'Soft7 company administrator not found');
    const current = await trx('companies').where({ id: user.company_id }).whereNull('deleted_at').forUpdate().first();
    const marker = current?.settings;
    if (user.company_id !== admin.company_id) {
      assert.ok(marker?.organization_type === 'platform' && marker.platform_admin_user_id === user.id &&
        marker.legacy_company_ids?.includes(admin.company_id), 'Superadmin already has an unrelated company; no changes made');
      assert.ok(!options.companyId || options.companyId === current.id, 'Already separated with a different company ID');
      return { replayed: true, platform_company_id: current.id, existing_company_id: admin.company_id,
        superadmin_email: user.email, superadmin_balance: user.credit_balance };
    }
    assert.ok(current?.status === 'active', 'Original company is not active');
    const companyId = options.companyId || randomUUID();
    assert.ok(companyId !== current.id, 'A new company ID is required');
    assert.ok(!await trx('companies').where({ id: companyId }).orWhereRaw('lower(email) = ?', [SUPERADMIN_EMAIL]).first('id'),
      'Platform company ID or email is already in use');
    const domains = await trx('company_domains').where({ company_id: current.id, status: 'active' }).orderBy('id');
    assert.ok(domains.length, 'No existing login domain is available to preserve');
    const preferred = domains.find(row => row.domain_name === 'superadmin.soft7.in') ||
      domains.find(row => row.user_id === user.id) || domains[0];
    const snapshot = await preservationSnapshot(trx, user.id, companyId, current.id);
    const directory = path.resolve(options.backupDirectory || path.join(__dirname, '../backups/platform-company-separation'));
    fs.mkdirSync(directory, { recursive: true });
    const backupPath = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.apply ? 'apply' : 'preview'}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ captured_at: new Date().toISOString(), platform_company_id: companyId,
      superadmin: user, company_admin: admin, original_company: current, preserved_domains: domains, preservation_snapshot: snapshot }, null, 2), { flag: 'wx' });
    const summary = { replayed: false, platform_company_id: companyId, existing_company_id: current.id,
      superadmin_email: user.email, superadmin_balance: user.credit_balance, existing_company_balance: current.credit_balance,
      preferred_login_domain: preferred.domain_name, preserved_table_count: Object.keys(snapshot).length, backup_path: backupPath };
    if (!options.apply) return { mode: 'preview', ...summary };
    const settings = { organization_type: 'platform', platform_admin_user_id: user.id,
      legacy_company_ids: [current.id], legacy_login_domain_ids: domains.map(row => row.id),
      preferred_login_domain: preferred.domain_name, separated_at: new Date().toISOString() };
    await trx('companies').insert({ id: companyId, name: 'Soft7 Platform', email: user.email,
      status: 'active', credit_balance: '0.00', domain: preferred.domain_name, settings: JSON.stringify(settings) });
    const [updated] = await trx('users').where({ id: user.id, company_id: current.id, role: 'superadmin' })
      .update({ company_id: companyId }).returning('*');
    assert.ok(updated, 'Superadmin link changed concurrently');
    const { company_id: previousCompany, ...previousFields } = user;
    const { company_id: nextCompany, ...nextFields } = updated;
    assert.deepEqual(nextFields, previousFields, 'An unrelated superadmin field changed');
    assert.deepEqual(await trx('companies').where({ id: current.id }).first(), current, 'Original company changed');
    assert.deepEqual(await trx('users').where({ id: admin.id }).first(), admin, 'Company administrator changed');
    await trx('superadmin_audit_logs').insert({ actor_id: user.id, company_id: companyId, target_id: user.id,
      action: 'platform.company_separate', reason: 'Dedicated Soft7 platform organization; preserve existing tenant data',
      changes: JSON.stringify({ previous_company_id: previousCompany, company_id: nextCompany,
        history_preserved: true, backup_path: backupPath }) });
    assert.deepEqual(await preservationSnapshot(trx, user.id, companyId, current.id), snapshot, 'Existing tenant data changed; rolling back');
    const applied = { mode: 'applied', ...summary, existing_tenant_data_unchanged: true, global_superadmin_role_preserved: true };
    if (options.rehearse) { rehearsalResult = { ...applied, mode: 'rehearsed_and_rolled_back' }; throw rehearsal; }
    return applied;
  }).catch(error => { if (error === rehearsal) return rehearsalResult; throw error; });
  if (result.backup_path) fs.writeFileSync(result.backup_path.replace(/\.json$/, '-result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}

module.exports = { separatePlatformCompany, preservationSnapshot };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--rehearse') { options.apply = true; options.rehearse = true; }
    else if (args[i] === '--company-id') options.companyId = args[++i];
    else throw Error('Supported arguments: --apply or --rehearse, --company-id <UUID>');
  }
  const db = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL,
    pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });
  separatePlatformCompany(db, options).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1; })
    .finally(() => db.destroy());
}
