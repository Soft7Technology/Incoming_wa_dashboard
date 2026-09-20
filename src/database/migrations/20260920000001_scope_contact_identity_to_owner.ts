import { Knex } from 'knex';

// Fails without changing data if existing contacts violate the new identity.
// Consolidate those duplicates before retrying; never delete contacts here.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE UNIQUE INDEX contacts_owner_phone_unique
    ON contacts (company_id, user_id, (COALESCE(phone_number_id::text, '')),
      (regexp_replace(phone_number, '[^0-9]', '', 'g')))
    WHERE deleted_at IS NULL`);
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_company_id_phone_number_unique');
  await knex.raw(`CREATE INDEX contacts_owner_page_idx
    ON contacts (user_id, company_id, created_at DESC, id DESC) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX waba_accounts_owner_idx
    ON waba_accounts (user_id, company_id) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX phone_numbers_owner_idx
    ON phone_numbers (user_id, company_id, waba_id) WHERE deleted_at IS NULL`);
}

export async function down(knex: Knex): Promise<void> {
  // Rollback may require consolidating contacts shared by different owners.
  await knex.schema.alterTable('contacts', table => {
    table.unique(['company_id', 'phone_number']);
  });
  await knex.raw('DROP INDEX contacts_owner_phone_unique');
  await knex.raw('DROP INDEX contacts_owner_page_idx');
  await knex.raw('DROP INDEX waba_accounts_owner_idx');
  await knex.raw('DROP INDEX phone_numbers_owner_idx');
}
