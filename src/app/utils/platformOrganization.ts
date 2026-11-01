import { Knex } from 'knex';

const isUuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

/** Explicit migration metadata permits reads of preserved records, never tenant-wide impersonation. */
export async function platformOrganization(db: Knex | Knex.Transaction, user: { id: string; role?: string; company_id?: string }) {
  if (user.role !== 'superadmin' || !user.company_id) return null;
  const company = await db('companies').where({ id: user.company_id }).whereNull('deleted_at').first('settings');
  const settings = company?.settings;
  return settings?.organization_type === 'platform' && settings.platform_admin_user_id === user.id ? settings : null;
}

export async function companyReadScope(db: Knex | Knex.Transaction, user: { id: string; role?: string; company_id?: string }) {
  const settings = await platformOrganization(db, user);
  const legacy: unknown[] = Array.isArray(settings?.legacy_company_ids) ? settings.legacy_company_ids : [];
  return [...new Set([user.company_id, ...legacy].filter(isUuid))];
}
