import { Knex } from 'knex';
import { auditContactPhones } from '../../app/utils/contactPhoneAudit';

export async function up(knex: Knex): Promise<void> {
  // Knex runs this migration in a transaction. Prevent writes between preflight and index creation.
  await knex.raw('LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE');
  if (!(await knex.schema.hasColumn('contacts', 'country_code'))) {
    await knex.schema.alterTable('contacts', table => { table.string('country_code', 3); });
  }
  const rows = await knex('contacts').select('id', 'company_id', 'user_id', 'phone_number_id',
    'phone_number', 'country_code', 'deleted_at');
  const { updates, issues } = auditContactPhones(rows);
  if (issues.length) {
    throw new Error(`Contact phone migration requires clarification for ${issues.length} records. ` +
      JSON.stringify(issues.slice(0, 20)) + '. Run scripts/audit-contact-phones.cjs for the full report.');
  }
  await knex.raw('DROP INDEX IF EXISTS contacts_owner_phone_unique');
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_company_id_phone_number_unique');
  for (let offset = 0; offset < updates.length; offset += 500) {
    await knex.raw(`UPDATE contacts AS c SET phone_number = n.phone_number, country_code = n.country_code
      FROM jsonb_to_recordset(?::jsonb) AS n(id uuid, phone_number text, country_code text)
      WHERE c.id = n.id`, [JSON.stringify(updates.slice(offset, offset + 500))]);
  }
  await knex.raw('ALTER TABLE contacts ALTER COLUMN country_code DROP DEFAULT');
  await knex.raw(`ALTER TABLE contacts ADD CONSTRAINT contacts_phone_digits_check
    CHECK (phone_number ~ '^[0-9]+$' AND country_code IS NOT NULL AND country_code ~ '^[1-9][0-9]{0,2}$')`);
  await knex.raw(`CREATE UNIQUE INDEX contacts_owner_phone_unique ON contacts
    (company_id, user_id, (COALESCE(phone_number_id::text, '')), country_code, phone_number)
    WHERE deleted_at IS NULL`);
}

export async function down(): Promise<void> {
  throw new Error('This data migration cannot be safely reversed automatically; restore the pre-migration backup.');
}
