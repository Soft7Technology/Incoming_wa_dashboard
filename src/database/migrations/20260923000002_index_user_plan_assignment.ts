import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Fails safely if legacy duplicates exist; reconcile those records first.
  await knex.raw('CREATE UNIQUE INDEX user_plans_one_active_per_user ON user_plans (user_id) WHERE active = true');
  await knex.schema.alterTable('user_plans', table => {
    table.index(['user_id', 'billing_cycle'], 'user_plans_user_billing_cycle_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX user_plans_one_active_per_user');
  await knex.schema.alterTable('user_plans', table => {
    table.dropIndex(['user_id', 'billing_cycle'], 'user_plans_user_billing_cycle_idx');
  });
}
