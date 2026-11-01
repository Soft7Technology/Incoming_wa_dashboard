import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('facebook_conversations', (table) => {
    table.string('participant_name', 255);
    table.timestamp('profile_checked_at', { useTz: true });
  });
  await knex.schema.alterTable('facebook_messages', (table) => {
    table.string('send_outcome', 20);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('facebook_messages', (table) => table.dropColumn('send_outcome'));
  await knex.schema.alterTable('facebook_conversations', (table) => {
    table.dropColumn('participant_name');
    table.dropColumn('profile_checked_at');
  });
}
