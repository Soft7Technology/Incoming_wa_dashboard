import { Knex } from 'knex';

export async function up(db: Knex): Promise<void> {
  await db.schema.alterTable('company_payment_gateways', table => {
    table.boolean('webhook_secret_configured').notNullable().defaultTo(false);
  });
  await db.schema.alterTable('company_payment_orders', table => {
    table.string('payment_flow', 20).notNullable().defaultTo('checkout');
    table.string('provider_payment_link_id', 100);
    table.string('link_status', 30);
    table.timestamp('next_check_at', { useTz: true });
    table.timestamp('last_checked_at', { useTz: true });
    table.string('fulfillment_error', 100);
    table.unique(['gateway_id', 'provider_payment_link_id']);
    table.index(['payment_flow', 'next_check_at']);
  });
}

export async function down(db: Knex): Promise<void> {
  if (await db('company_payment_orders').where({ payment_flow: 'link' }).first('id')) {
    throw new Error('Cannot remove payment-link reconciliation fields while purchase history exists');
  }
  await db.schema.alterTable('company_payment_orders', table => {
    table.dropUnique(['gateway_id', 'provider_payment_link_id']);
    table.dropIndex(['payment_flow', 'next_check_at']);
    table.dropColumns('payment_flow', 'provider_payment_link_id', 'link_status', 'next_check_at', 'last_checked_at', 'fulfillment_error');
  });
  await db.schema.alterTable('company_payment_gateways', table => {
    table.dropColumn('webhook_secret_configured');
  });
}
