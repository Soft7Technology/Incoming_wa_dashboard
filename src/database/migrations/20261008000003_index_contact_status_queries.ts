import { Knex } from 'knex';

export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Global contact listing: restrict account + status before sorting/pagination.
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_account_status_created_idx
    ON contacts (user_id, company_id, status, created_at DESC, id ASC)
    WHERE deleted_at IS NULL`);
  // Sender-specific listing can restrict the phone number before scanning a status.
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_phone_status_created_idx
    ON contacts (user_id, company_id, phone_number_id, status, created_at DESC, id ASC)
    WHERE deleted_at IS NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS contacts_phone_status_created_idx');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS contacts_account_status_created_idx');
}
