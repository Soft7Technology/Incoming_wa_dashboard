import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('instagram_accounts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('instagram_id', 80).notNullable().unique();
    t.string('page_id', 80).notNullable();
    t.string('page_name').notNullable();
    t.string('username').notNullable();
    t.string('facebook_user_id', 80).notNullable();
    t.text('token_ciphertext');
    t.timestamp('token_expires_at', { useTz: true });
    t.timestamp('data_access_expires_at', { useTz: true });
    t.string('status').notNullable().defaultTo('connected');
    t.timestamp('connected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['company_id', 'owner_id']);
  });
  await knex.schema.createTable('instagram_oauth_sessions', (t) => {
    t.string('state_hash', 64).primary();
    t.string('browser_hash', 64).notNullable().index();
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('status').notNullable().defaultTo('started');
    t.string('facebook_user_id', 80);
    t.text('candidates_ciphertext');
    t.text('error');
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
  });
  await knex.schema.createTable('instagram_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('account_id').notNullable().references('id').inTable('instagram_accounts').onDelete('CASCADE');
    t.string('kind', 30).notNullable();
    t.string('remote_id', 200).notNullable();
    t.string('parent_id', 200);
    t.jsonb('payload').notNullable();
    t.timestamp('event_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['account_id', 'kind', 'remote_id']);
    t.index(['account_id', 'kind', 'parent_id', 'event_at']);
  });
  await knex.schema.createTable('instagram_actions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('account_id').notNullable().references('id').inTable('instagram_accounts').onDelete('CASCADE');
    t.uuid('request_id').notNullable();
    t.string('fingerprint', 64).notNullable();
    t.string('status').notNullable().defaultTo('pending');
    t.jsonb('result');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['account_id', 'request_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('instagram_actions');
  await knex.schema.dropTableIfExists('instagram_records');
  await knex.schema.dropTableIfExists('instagram_oauth_sessions');
  await knex.schema.dropTableIfExists('instagram_accounts');
}
