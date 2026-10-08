import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', table => {
    // Viewing a chat is independent of the customer's WhatsApp delivery receipt.
    table.timestamp('inbox_read_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', table => table.dropColumn('inbox_read_at'));
}
