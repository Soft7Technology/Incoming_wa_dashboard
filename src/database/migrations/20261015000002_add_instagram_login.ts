import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('instagram_accounts', (t) => {
    t.string('auth_provider', 20).notNullable().defaultTo('facebook');
    t.string('provider_app_id', 80);
    t.string('provider_user_id', 80);
    t.timestamp('token_refreshed_at', { useTz: true });
    t.string('page_id', 80).nullable().alter();
    t.string('page_name').nullable().alter();
    t.string('facebook_user_id', 80).nullable().alter();
  });
  await knex.schema.alterTable('instagram_oauth_sessions', (t) => {
    t.string('auth_provider', 20).notNullable().defaultTo('facebook');
    t.string('provider_app_id', 80);
    t.string('provider_user_id', 80);
    t.text('redirect_uri');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Rolling back would discard direct connections or require fake Facebook IDs.
  if (await knex('instagram_accounts').where({ auth_provider: 'instagram' }).first())
    throw new Error('Remove direct Instagram connections before rolling back this migration.');
  await knex.schema.alterTable('instagram_accounts', (t) => {
    t.dropColumns('auth_provider', 'provider_app_id', 'provider_user_id', 'token_refreshed_at');
    t.string('page_id', 80).notNullable().alter();
    t.string('page_name').notNullable().alter();
    t.string('facebook_user_id', 80).notNullable().alter();
  });
  await knex.schema.alterTable('instagram_oauth_sessions', (t) => {
    t.dropColumns('auth_provider', 'provider_app_id', 'provider_user_id', 'redirect_uri');
  });
}
