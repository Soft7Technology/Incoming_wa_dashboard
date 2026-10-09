import { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contacts', table => {
    table.boolean('is_opted_out').notNullable().defaultTo(false);
  });
  await knex.schema.alterTable('phone_numbers', table => {
    table.jsonb('opt_in_keywords').notNullable().defaultTo('["START"]');
    table.jsonb('opt_out_keywords').notNullable().defaultTo('["STOP","UNSUBSCRIBE"]');
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('phone_numbers', table => { table.dropColumn('opt_in_keywords'); table.dropColumn('opt_out_keywords'); });
  await knex.schema.alterTable('contacts', table => table.dropColumn('is_opted_out'));
}
