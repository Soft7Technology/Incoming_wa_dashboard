import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('facebook_messages', 'payload'))) {
    await knex.schema.alterTable('facebook_messages', (table) => {
      table.jsonb('payload');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('facebook_messages', (table) => {
    table.dropColumn('payload');
  });
}
