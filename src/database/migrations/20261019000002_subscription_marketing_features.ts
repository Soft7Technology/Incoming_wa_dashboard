import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('subscription_plans', 'marketing_features')) return;
  await knex.schema.alterTable('subscription_plans', table => {
    table.jsonb('marketing_features').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscription_plans', table => {
    table.dropColumn('marketing_features');
  });
}
