import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('contacts', 'custom_fields'))) {
    await knex.schema.alterTable('contacts', table => {
      table.jsonb('custom_fields').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    });

    // Preserve custom data stored under the previous attributes column.
    await knex('contacts').update({
      custom_fields: knex.raw("COALESCE(attributes, '{}'::jsonb)"),
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('contacts', 'custom_fields')) {
    await knex.schema.alterTable('contacts', table => {
      table.dropColumn('custom_fields');
    });
  }
}
