import { Knex } from 'knex';

// Lets customers pay for add-on packs through a Razorpay payment link.
// Plan orders keep using user_plan_id (unique: one order per pending plan);
// add-on orders point at the active plan they top up, which can have many.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('company_payment_orders', table => {
    table.string('purchase_type', 20).notNullable().defaultTo('plan');
    table.uuid('addon_id').nullable().references('id').inTable('plan_addons').onDelete('RESTRICT');
    table.uuid('addon_user_plan_id').nullable().references('id').inTable('user_plans').onDelete('RESTRICT');
    table.integer('addon_quantity').nullable();
    table.uuid('addon_purchase_id').nullable().references('id').inTable('user_plan_addons').onDelete('RESTRICT');
    table.index(['addon_user_plan_id']);
  });
  await knex.raw(`ALTER TABLE company_payment_orders ADD CONSTRAINT company_payment_orders_addon_fields CHECK (
    (purchase_type = 'plan' AND addon_id IS NULL AND addon_user_plan_id IS NULL AND addon_quantity IS NULL)
    OR (purchase_type = 'addon' AND addon_id IS NOT NULL AND addon_user_plan_id IS NOT NULL
        AND addon_quantity > 0 AND user_plan_id IS NULL)
  )`);
}

export async function down(knex: Knex): Promise<void> {
  if (await knex('company_payment_orders').where({ purchase_type: 'addon' }).first('id')) {
    throw new Error('Cannot remove add-on payment fields while add-on purchase history exists');
  }
  await knex.raw('ALTER TABLE company_payment_orders DROP CONSTRAINT IF EXISTS company_payment_orders_addon_fields');
  await knex.schema.alterTable('company_payment_orders', table => {
    table.dropIndex(['addon_user_plan_id']);
    table.dropColumns('addon_purchase_id', 'addon_quantity', 'addon_user_plan_id', 'addon_id', 'purchase_type');
  });
}
