import { Knex } from 'knex';

export async function up(db: Knex): Promise<void> {
  await db.schema.createTable('credit_topup_orders', table => {
    table.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('RESTRICT');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    table.string('idempotency_key', 100).notNullable();
    table.integer('amount_paise').notNullable();
    table.string('currency', 3).notNullable().defaultTo('INR');
    table.string('status', 30).notNullable().defaultTo('creating');
    table.string('provider_key_id', 100).notNullable();
    table.string('provider_qr_id', 100).unique();
    table.text('qr_image_url');
    table.string('provider_payment_id', 100).unique();
    table.integer('paid_amount_paise');
    table.integer('refunded_amount_paise').notNullable().defaultTo(0);
    table.uuid('ledger_transaction_id').unique().references('id').inTable('credit_transactions').onDelete('RESTRICT');
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('paid_at', { useTz: true });
    table.timestamp('credited_at', { useTz: true });
    table.timestamp('last_checked_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    table.unique(['company_id', 'user_id', 'idempotency_key']);
    table.index(['company_id', 'created_at']);
  });
  await db.raw(`ALTER TABLE credit_topup_orders ADD CONSTRAINT credit_topup_order_valid CHECK (
    amount_paise BETWEEN 100 AND 100000000 AND currency = 'INR'
    AND status IN ('creating', 'pending', 'creation_unknown', 'expired', 'closed', 'credited', 'partially_refunded', 'refunded')
    AND (paid_amount_paise IS NULL OR paid_amount_paise = amount_paise)
    AND refunded_amount_paise BETWEEN 0 AND amount_paise
    AND (ledger_transaction_id IS NULL OR (provider_payment_id IS NOT NULL AND paid_amount_paise IS NOT NULL)))`);
  await db.schema.createTable('credit_topup_webhook_events', table => {
    table.string('id', 150).primary();
    table.string('payload_hash', 64).notNullable();
    table.uuid('topup_id').notNullable().references('id').inTable('credit_topup_orders').onDelete('RESTRICT');
    table.string('event', 100).notNullable();
    table.timestamp('processed_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
  });
  // Protect the money ledger even if a later caller bypasses order fulfillment.
  await db.raw(`CREATE UNIQUE INDEX credit_razorpay_topup_unique ON credit_transactions(reference_id)
    WHERE reference_type = 'razorpay_topup'`);
}

export async function down(db: Knex): Promise<void> {
  // A rollback must never erase financial receipts after the feature is used.
  const receipt = await db('credit_topup_orders').first('id');
  if (receipt) throw new Error('Credit top-ups have financial history; retain the tables and reconcile before rollback');
  await db.schema.dropTable('credit_topup_webhook_events');
  await db.schema.dropTable('credit_topup_orders');
  await db.raw('DROP INDEX credit_razorpay_topup_unique');
}
