import { Knex } from 'knex';
import { auditContactPhones } from '../../app/utils/contactPhoneAudit';
import { toContactPhone } from '../../app/utils/importPhone';

/** Migrate all records atomically; stop before changes if an identity is ambiguous. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE');
  const rows = await knex('contacts').select('id', 'company_id', 'user_id', 'phone_number_id', 'phone_number', 'country_code', 'deleted_at');
  const { updates, issues } = auditContactPhones(rows);
  if (issues.length) throw new Error(`Contact international-number migration requires review: ${JSON.stringify(issues.slice(0, 20))}`);
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_digits_check');
  await knex.raw('DROP INDEX IF EXISTS contacts_owner_phone_unique');
  await knex.raw('ALTER TABLE contacts ALTER COLUMN country_code DROP NOT NULL');
  for (const row of updates) await knex('contacts').where({ id: row.id }).update(toContactPhone(row));
  await knex.raw(`ALTER TABLE contacts ADD CONSTRAINT contacts_phone_digits_check
    CHECK (phone_number ~ '^[+][1-9][0-9]{1,14}$' AND
      (country_code IS NULL OR (country_code ~ '^[1-9][0-9]{0,2}$' AND phone_number LIKE '+' || country_code || '%')))`);
  await knex.raw(`CREATE UNIQUE INDEX contacts_owner_phone_unique ON contacts
    (company_id, user_id, (COALESCE(phone_number_id::text, '')), phone_number) WHERE deleted_at IS NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE');
  const rows = await knex('contacts').select('id', 'company_id', 'user_id', 'phone_number_id', 'phone_number', 'country_code', 'deleted_at');
  const { updates, issues } = auditContactPhones(rows);
  if (issues.length) throw new Error('Contact rollback requires resolving invalid or duplicate phone identities first');
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT contacts_phone_digits_check');
  await knex.raw('DROP INDEX contacts_owner_phone_unique');
  for (const row of updates) await knex('contacts').where({ id: row.id }).update({ phone_number: row.phone_number, country_code: row.country_code });
  await knex.raw(`ALTER TABLE contacts ADD CONSTRAINT contacts_phone_digits_check
    CHECK (phone_number ~ '^[0-9]+$' AND country_code IS NOT NULL AND country_code ~ '^[1-9][0-9]{0,2}$')`);
  await knex.raw(`CREATE UNIQUE INDEX contacts_owner_phone_unique ON contacts
    (company_id, user_id, (COALESCE(phone_number_id::text, '')), country_code, phone_number) WHERE deleted_at IS NULL`);
}
