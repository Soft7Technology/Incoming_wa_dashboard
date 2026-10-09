import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contacts', table => {
    // Historical contacts have no reliable creation source.
    table.enum('source', ['import', 'manually', 'whatsApp']).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contacts', table => table.dropColumn('source'));
}
