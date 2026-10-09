import { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('superadmin_audit_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('actor_id').notNullable();
    table.uuid('company_id').notNullable();
    table.uuid('target_id').notNullable();
    table.string('action', 80).notNullable();
    table.text('reason').notNullable();
    table.jsonb('changes').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['company_id', 'created_at']);
  });
  await knex.raw(`CREATE UNIQUE INDEX credit_superadmin_request_unique ON credit_transactions(company_id, reference_id)
    WHERE reference_type = 'superadmin_manual'`);
}
export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX credit_superadmin_request_unique');
  await knex.schema.dropTable('superadmin_audit_logs');
}
