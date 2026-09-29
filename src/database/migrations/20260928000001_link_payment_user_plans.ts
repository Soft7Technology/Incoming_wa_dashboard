import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('company_payment_orders', table => {
    table.uuid('user_plan_id').nullable().references('id').inTable('user_plans').onDelete('RESTRICT');
    table.timestamp('fulfilled_at', { useTz: true }).nullable();
    table.unique(['user_plan_id']);
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('company_payment_orders', table => {
    table.dropColumn('fulfilled_at');
    table.dropColumn('user_plan_id');
  });
}
