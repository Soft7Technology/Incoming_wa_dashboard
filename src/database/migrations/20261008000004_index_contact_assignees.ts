import { Knex } from 'knex';

export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // GIN supports both selected-assignee overlap (&&) and team access (@>).
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_active_assigned_to_idx
    ON contacts USING GIN (assigned_to)
    WHERE deleted_at IS NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS contacts_active_assigned_to_idx');
}
