import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('platform_fee_settings', table => {
    table.string('id', 32).primary();
    table.string('currency', 3).notNullable().defaultTo('INR');
    table.integer('monthly_fee_paise').notNullable();
    table.integer('yearly_fee_paise').notNullable();
    table.uuid('updated_by').nullable().references('id').inTable('users');
    table.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE platform_fee_settings ADD CONSTRAINT platform_fee_settings_valid
    CHECK (id = 'default' AND currency = 'INR' AND monthly_fee_paise BETWEEN 0 AND 100000000
      AND yearly_fee_paise BETWEEN 0 AND 100000000)`);
  // Preserve the existing platform fees until a superadmin explicitly changes them.
  await knex('platform_fee_settings').insert({ id: 'default', monthly_fee_paise: 10000, yearly_fee_paise: 100000 });
  await knex.schema.createTable('platform_pricing_changes', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('actor_id').notNullable().references('id').inTable('users');
    table.string('resource_type', 32).notNullable();
    table.string('resource_id', 64).notNullable();
    table.jsonb('previous_values').notNullable();
    table.jsonb('new_values').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.alterTable('user_plans', table => { table.integer('platform_fee_paise').nullable(); });
  await knex.raw(`ALTER TABLE user_plans ADD CONSTRAINT user_plans_platform_fee_valid
    CHECK (platform_fee_paise IS NULL OR platform_fee_paise BETWEEN 0 AND 100000000)`);
  // Existing unpaid orders retain their old fee, even after the policy is edited.
  await knex('user_plans').where({ active: false, status: 'pending', billing_cycle: 'Monthly' })
    .update({ platform_fee_paise: 10000 });
  await knex('user_plans').where({ active: false, status: 'pending', billing_cycle: 'Yearly' })
    .update({ platform_fee_paise: 100000 });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE user_plans DROP CONSTRAINT user_plans_platform_fee_valid');
  await knex.schema.alterTable('user_plans', table => { table.dropColumn('platform_fee_paise'); });
  await knex.schema.dropTable('platform_pricing_changes');
  await knex.schema.dropTable('platform_fee_settings');
}
