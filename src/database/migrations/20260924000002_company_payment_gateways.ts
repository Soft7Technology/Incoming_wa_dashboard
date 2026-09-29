import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('company_payment_gateways', table => {
    table.uuid('id').primary();
    table.uuid('company_id').notNullable().references('id').inTable('companies');
    table.enum('provider', ['razorpay', 'cashfree']).notNullable();
    table.enum('mode', ['test', 'live']).notNullable();
    table.text('credentials_encrypted').notNullable();
    table.string('display_name', 100).notNullable();
    table.boolean('active').notNullable().defaultTo(true);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['company_id']);
  });
  // Configuration versions are retained so outstanding orders survive credential changes.
  await knex.raw(`CREATE UNIQUE INDEX company_payment_gateway_active
    ON company_payment_gateways(company_id, mode) WHERE active = true`);
  await knex.schema.createTable('company_payment_orders', table => {
    table.uuid('id').primary();
    table.uuid('company_id').notNullable().references('id').inTable('companies');
    table.uuid('user_id').notNullable().references('id').inTable('users');
    table.uuid('gateway_id').notNullable().references('id').inTable('company_payment_gateways');
    table.string('idempotency_key', 100).notNullable();
    table.string('request_hash', 64).notNullable();
    table.integer('amount_paise').notNullable();
    table.string('currency', 3).notNullable().defaultTo('INR');
    table.boolean('is_test').notNullable();
    table.enum('status', ['creating', 'pending', 'paid', 'creation_unknown']).notNullable();
    table.string('provider_order_id', 100);
    table.jsonb('checkout');
    table.timestamp('paid_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['company_id', 'user_id', 'idempotency_key']);
    table.unique(['gateway_id', 'provider_order_id']);
    table.index(['company_id', 'user_id', 'created_at']);
  });
  await knex.raw('ALTER TABLE company_payment_orders ADD CHECK (amount_paise >= 100)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('company_payment_orders');
  await knex.schema.dropTable('company_payment_gateways');
}
