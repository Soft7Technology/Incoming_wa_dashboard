import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('facebook_pages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    // A webhook contains only a Page ID; it must resolve to exactly one tenant.
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
  await knex.schema.createTable('facebook_oauth_sessions', (t) => {
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
  await knex.schema.createTable('facebook_conversations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('page_connection_id').notNullable().references('id').inTable('facebook_pages').onDelete('CASCADE');
    t.string('psid', 80).notNullable();
    t.timestamp('last_customer_message_at', { useTz: true });
    t.timestamp('last_message_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.bigInteger('delivery_watermark').notNullable().defaultTo(0);
    t.bigInteger('read_watermark').notNullable().defaultTo(0);
    t.unique(['page_connection_id', 'psid']);
    t.index(['page_connection_id', 'last_message_at']);
  });
  await knex.schema.createTable('facebook_messages', (t) => {
    t.uuid('id').primary();
    t.uuid('conversation_id').notNullable().references('id').inTable('facebook_conversations').onDelete('CASCADE');
    t.uuid('page_connection_id').notNullable().references('id').inTable('facebook_pages').onDelete('CASCADE');
    t.string('meta_message_id', 255);
    t.uuid('client_request_id');
    t.uuid('agent_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('direction', 20).notNullable();
    t.text('text').notNullable();
    t.string('status', 20).notNullable();
    t.text('error');
    t.timestamp('event_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['page_connection_id', 'meta_message_id']);
    t.unique(['conversation_id', 'client_request_id']);
    t.index(['conversation_id', 'event_at']);
  });
  await knex.schema.createTable('facebook_deletion_requests', (t) => {
    t.string('confirmation_hash', 64).primary();
    t.string('status', 20).notNullable();
    t.timestamp('completed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'facebook_deletion_requests',
    'facebook_messages',
    'facebook_conversations',
    'facebook_oauth_sessions',
    'facebook_pages',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
