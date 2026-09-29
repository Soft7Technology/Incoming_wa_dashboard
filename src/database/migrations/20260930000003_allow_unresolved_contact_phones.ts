import { Knex } from 'knex';
import { parseStoredContactPhone } from '../../app/utils/importPhone';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE');
  const rows = await knex('contacts').select('*');
  const seen = new Set<string>();
  const updates = rows.map(row => {
    const identity = parseStoredContactPhone(row.phone_number, row.country_code || '');
    const key = JSON.stringify([row.company_id, row.user_id, row.phone_number_id, identity.phone_number]);
    if (!row.deleted_at && seen.has(key)) throw new Error('Duplicate contact identity; resolve duplicates before migrating');
    if (!row.deleted_at) seen.add(key);
    return { id: row.id, ...identity, is_valid: identity.is_valid && row.is_valid !== false };
  });
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_digits_check');
  await knex.raw('DROP INDEX IF EXISTS contacts_owner_phone_unique');
  await knex.raw('ALTER TABLE contacts ALTER COLUMN country_code DROP NOT NULL');
  for (const row of updates) {
    const { id, ...values } = row;
    await knex('contacts').where({ id }).update(values);
  }
  await knex.raw(`ALTER TABLE contacts ADD CONSTRAINT contacts_phone_digits_check CHECK (
    phone_number ~ '^[+][0-9]{4,15}$' AND
    ((country_code IS NULL AND is_valid IS FALSE) OR
    (country_code IS NOT NULL AND country_code ~ '^[1-9][0-9]{0,2}$' AND phone_number LIKE '+' || country_code || '%')))`);
  await knex.raw(`CREATE UNIQUE INDEX contacts_owner_phone_unique ON contacts
    (company_id, user_id, (COALESCE(phone_number_id::text, '')), phone_number) WHERE deleted_at IS NULL`);
}

export async function down(): Promise<void> {
  throw new Error('Resolve contacts without country codes and back up data before restoring split-phone storage');
}
