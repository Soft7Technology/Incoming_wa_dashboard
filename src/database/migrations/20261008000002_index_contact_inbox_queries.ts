import { Knex } from 'knex';

// Building these indexes must not block incoming messages on a busy database.
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Match the expression used by latest-message, read-status and inbox count queries.
  // Equality keys come first so each contact can read its latest index entry directly.
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_inbox_conversation_idx
    ON messages (user_id, company_id, phone_number_id,
      (CASE WHEN direction = 'inbound'
        THEN regexp_replace(from_phone, '[^0-9]', '', 'g')
        ELSE regexp_replace(to_phone, '[^0-9]', '', 'g') END),
      created_at DESC NULLS LAST, id DESC)
    INCLUDE (direction, status, read_at, inbox_read_at)`);
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_inbox_scope_idx
    ON contacts (user_id, company_id, phone_number_id, created_at DESC, id ASC)
    WHERE deleted_at IS NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS contacts_inbox_scope_idx');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS messages_inbox_conversation_idx');
}
