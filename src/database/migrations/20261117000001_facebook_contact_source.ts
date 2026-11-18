import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // The original Knex enum uses a VARCHAR column with a PostgreSQL CHECK.
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_source_check');
  await knex.raw(`ALTER TABLE contacts ADD CONSTRAINT contacts_source_check
    CHECK (source IN ('import', 'manually', 'whatsApp', 'facebook'))`);
}

export async function down(knex: Knex): Promise<void> {
  // Do not silently relabel contacts whose provenance has already been saved.
  if (await knex('contacts').where({ source: 'facebook' }).first('id')) {
    throw new Error('Cannot remove Facebook source while Facebook contacts exist.');
  }
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_source_check');
  await knex.raw(`ALTER TABLE contacts ADD CONSTRAINT contacts_source_check
    CHECK (source IN ('import', 'manually', 'whatsApp'))`);
}
