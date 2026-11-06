import type { Knex } from 'knex';

const tables = ['facebook_oauth_sessions', 'facebook_lead_oauth_sessions', 'instagram_oauth_sessions'];

export async function up(knex: Knex): Promise<void> {
  for (const name of tables) await knex.schema.alterTable(name, table => {
    table.text('frontend_origin').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const name of tables) await knex.schema.alterTable(name, table => {
    table.dropColumn('frontend_origin');
  });
}
