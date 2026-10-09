import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Include deleted identities: recreating a contact must not bypass suppression.
  await knex.raw(`CREATE INDEX contacts_campaign_opt_out_idx
    ON contacts (company_id, user_id, phone_number_id, country_code, phone_number)
    WHERE is_opted_out = true`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS contacts_campaign_opt_out_idx');
}
