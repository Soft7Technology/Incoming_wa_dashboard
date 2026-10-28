import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('google_people_oauth_apps', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('client_id', 500).notNullable();
    t.text('client_secret_ciphertext').notNullable();
    t.timestamps(true, true);
    t.unique(['company_id', 'owner_id']);
  });
  await knex.schema.createTable('google_people_oauth_sessions', (t) => {
    t.string('state_hash', 64).primary();
    t.string('browser_hash', 64).notNullable();
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('verifier_ciphertext').notNullable();
    t.text('client_context_ciphertext').notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
    t.timestamp('consumed_at', { useTz: true });
  });
  await knex.schema.createTable('google_people_connections', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('client_context_ciphertext').notNullable();
    t.text('access_token_ciphertext').notNullable();
    t.text('refresh_token_ciphertext').notNullable();
    t.timestamp('token_expires_at', { useTz: true }).notNullable();
    t.jsonb('scopes').notNullable();
    t.timestamps(true, true);
    t.unique(['company_id', 'owner_id']);
  });
}
export async function down(knex: Knex): Promise<void> {
  for (const table of ['google_people_connections', 'google_people_oauth_sessions', 'google_people_oauth_apps'])
    await knex.schema.dropTable(table);
}
