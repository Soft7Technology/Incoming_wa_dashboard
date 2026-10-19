import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('facebook_lead_pages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('page_id', 80).notNullable().unique();
    t.string('name').notNullable();
    t.string('facebook_user_id', 80).notNullable();
    t.text('token_ciphertext');
    t.timestamp('token_expires_at', { useTz: true });
    t.timestamp('data_access_expires_at', { useTz: true });
    t.string('status', 40).notNullable();
    t.text('error');
    t.timestamp('connected_at', { useTz: true });
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['company_id', 'owner_id']);
  });
  await knex.schema.createTable('facebook_lead_oauth_sessions', (t) => {
    t.string('state_hash', 64).primary();
    t.string('browser_hash', 64).notNullable();
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('facebook_user_id', 80);
    t.string('status', 40).notNullable().defaultTo('started');
    t.text('candidates_ciphertext');
    t.text('error');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.index(['expires_at']);
  });
  await knex.schema.createTable('facebook_lead_forms', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('page_connection_id').notNullable().references('id').inTable('facebook_lead_pages').onDelete('CASCADE');
    t.string('form_id', 80).notNullable();
    t.string('name').notNullable();
    t.string('status', 40);
    t.jsonb('questions').notNullable().defaultTo('[]');
    t.boolean('enabled').notNullable().defaultTo(false);
    t.timestamp('last_synced_at', { useTz: true });
    t.text('sync_error');
    t.unique(['page_connection_id', 'form_id']);
  });
  await knex.schema.createTable('facebook_leads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('form_connection_id').notNullable().references('id').inTable('facebook_lead_forms').onDelete('CASCADE');
    t.string('lead_id', 80).notNullable();
    t.jsonb('field_data').notNullable();
    t.timestamp('submitted_at', { useTz: true }).notNullable();
    t.timestamp('synced_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['form_connection_id', 'lead_id']);
    t.index(['form_connection_id', 'submitted_at', 'id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'facebook_leads',
    'facebook_lead_forms',
    'facebook_lead_oauth_sessions',
    'facebook_lead_pages',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
