import { Knex } from 'knex';

export async function up(db: Knex): Promise<void> {
  await db.schema.alterTable('company_payment_gateways', table => {
    table.timestamp('webhook_verified_at', { useTz: true }).nullable();
  });
}

export async function down(db: Knex): Promise<void> {
  await db.schema.alterTable('company_payment_gateways', table => {
    table.dropColumn('webhook_verified_at');
  });
}
