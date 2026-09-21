import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_api_keys', table => {
    table.text('api_key_encrypted').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_api_keys', table => {
    table.dropColumn('api_key_encrypted');
  });
}
