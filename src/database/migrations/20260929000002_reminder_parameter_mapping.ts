import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reminders', (table) => {
    table.jsonb('parameter_mapping').nullable();
    table.jsonb('media_uploads').notNullable().defaultTo('[]');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reminders', (table) => {
    table.dropColumn('parameter_mapping');
    table.dropColumn('media_uploads');
  });
}
