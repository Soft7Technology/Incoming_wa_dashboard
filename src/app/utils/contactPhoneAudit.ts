import { parseImportedPhone } from './importPhone';

/** Pure preflight shared by the read-only audit and the transactional migration. */
export function auditContactPhones(rows: any[]) {
  const updates: any[] = [];
  const issues: { id: string; reason: string }[] = [];
  const identities = new Map<string, string>();
  for (const row of rows) {
    try {
      const identity = parseImportedPhone(row.phone_number, row.country_code || '', Boolean(row.country_code));
      const key = JSON.stringify([row.company_id, row.user_id, row.phone_number_id ?? null,
        identity.country_code, identity.phone_number]);
      if (!row.deleted_at) {
        const previous = identities.get(key);
        if (previous) issues.push({ id: row.id, reason: `Duplicate normalized identity with contact ${previous}` });
        else identities.set(key, row.id);
      }
      updates.push({ id: row.id, ...identity });
    } catch (error: any) {
      issues.push({ id: row.id, reason: error.message });
    }
  }
  return { updates, issues };
}
