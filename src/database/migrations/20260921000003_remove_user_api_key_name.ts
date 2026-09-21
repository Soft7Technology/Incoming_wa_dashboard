import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('user_api_keys', 'name')) {
    await knex.schema.alterTable('user_api_keys', table => {
      table.dropColumn('name');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Previous labels cannot be recovered; provide a label for existing keys.
  await knex.schema.alterTable('user_api_keys', table => {
    table.string('name', 100).notNullable().defaultTo('API key');
  });
}
