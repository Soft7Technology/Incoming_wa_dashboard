import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Shared packs must never carry one company's markup into another company's catalog.
  await knex.schema.createTable('company_addon_pricing', t => {
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('RESTRICT');
    t.uuid('addon_id').notNullable().references('id').inTable('plan_addons').onDelete('RESTRICT');
    t.integer('markup_paise').notNullable().defaultTo(0);
    t.uuid('updated_by').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamps(true, true);
    t.primary(['company_id', 'addon_id']);
  });
  await knex.raw('ALTER TABLE company_addon_pricing ADD CONSTRAINT addon_markup_range CHECK (markup_paise >= 0 AND markup_paise <= 100000000)');
  await knex.schema.alterTable('user_plan_addons', t => {
    t.bigInteger('platform_fee_paise');
    t.bigInteger('markup_paise').notNullable().defaultTo(0);
    t.bigInteger('total_price_paise');
  });
  await knex.raw('UPDATE user_plan_addons SET platform_fee_paise = amount_paise, total_price_paise = amount_paise');
  await knex.raw(`ALTER TABLE user_plan_addons
    ALTER COLUMN platform_fee_paise SET NOT NULL,
    ALTER COLUMN total_price_paise SET NOT NULL,
    ADD CONSTRAINT addon_purchase_price_totals CHECK (
      platform_fee_paise = amount_paise AND platform_fee_paise > 0 AND markup_paise >= 0
      AND total_price_paise = platform_fee_paise + markup_paise)`);
}

export async function down(knex: Knex): Promise<void> {
  if (await knex('user_plan_addons').where('markup_paise', '>', 0).first())
    throw new Error('Preserve or reconcile add-on markup purchase snapshots before rollback');
  await knex.raw('ALTER TABLE user_plan_addons DROP CONSTRAINT addon_purchase_price_totals');
  await knex.schema.alterTable('user_plan_addons', t => {
    t.dropColumn('platform_fee_paise'); t.dropColumn('markup_paise'); t.dropColumn('total_price_paise');
  });
  await knex.schema.dropTable('company_addon_pricing');
}
