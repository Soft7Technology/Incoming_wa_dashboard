import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaigns', table => {
    table.text('failure_reason');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaigns', table => {
    table.dropColumn('failure_reason');
  });
}
