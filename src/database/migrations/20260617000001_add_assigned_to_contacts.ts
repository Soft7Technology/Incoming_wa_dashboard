import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('contacts', 'assigned_to');
  if (hasColumn) return;

  await knex.schema.alterTable('contacts', (table) => {
    // nullable FK to users — the team member this contact/chat is assigned to
    table
      .uuid('assigned_to')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');

    table.index(['assigned_to']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contacts', (table) => {
    table.dropColumn('assigned_to');
  });
}
