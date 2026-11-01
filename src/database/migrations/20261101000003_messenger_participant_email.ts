import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('facebook_conversations', table => {
    table.string('participant_email', 254);
    table.string('participant_email_source', 20);
    table.timestamp('participant_email_at', { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('facebook_conversations', table => {
    table.dropColumn('participant_email');
    table.dropColumn('participant_email_source');
    table.dropColumn('participant_email_at');
  });
}
