import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscription_plans', table => {
    table.integer('trial_days').nullable();
  });
  await knex('subscription_plans').where('billing_cycle', 'Free').update({ trial_days: 3 });
  await knex.raw(`ALTER TABLE subscription_plans ADD CONSTRAINT subscription_trial_days_check
    CHECK (trial_days IS NULL OR (billing_cycle = 'Free' AND trial_days IN (3, 7, 10)))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE subscription_plans DROP CONSTRAINT subscription_trial_days_check');
  await knex.schema.alterTable('subscription_plans', table => {
    table.dropColumn('trial_days');
  });
}
