import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex.raw("SET LOCAL statement_timeout = '60s'");
  // PostgreSQL also removes this column's foreign key, including ON DELETE CASCADE.
  // All purchased/assigned plan snapshots and users.assigned_plan remain intact.
  await knex.raw('ALTER TABLE user_plans DROP COLUMN IF EXISTS subscription_id');
}

export async function down(knex: Knex): Promise<void> {
  // Removed source IDs cannot be reconstructed; never guess from a plan's name.
  // Rollback keeps snapshots and cannot reintroduce cascading plan deletion.
  await knex.schema.alterTable('user_plans', table => {
    table.uuid('subscription_id').nullable().references('id').inTable('subscription_plans').onDelete('SET NULL');
  });
}
