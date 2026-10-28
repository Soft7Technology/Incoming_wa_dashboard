import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('shopify_connections', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('shop_domain', 100).notNullable().unique();
    t.string('shop_id', 120).notNullable();
    t.string('name', 120).notNullable();
    t.text('access_token_ciphertext');
    t.text('refresh_token_ciphertext');
    t.timestamp('token_expires_at', { useTz: true });
    t.timestamp('refresh_expires_at', { useTz: true });
    t.jsonb('scopes').notNullable();
    t.jsonb('desired_topics').notNullable();
    t.text('delivery_token_ciphertext').notNullable();
    t.string('status', 30).notNullable().defaultTo('connected');
    t.timestamp('connected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string('subscription_issue', 300);
    t.timestamps(true, true);
    t.index(['company_id', 'owner_id']);
  });
  await knex.schema.createTable('shopify_oauth_sessions', (t) => {
    t.string('state_hash', 64).primary();
    t.string('browser_hash', 64).notNullable();
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('shop_domain', 100).notNullable();
    t.string('name', 120).notNullable();
    t.string('client_id', 120).notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
    t.timestamp('consumed_at', { useTz: true });
  });
  await knex.schema.createTable('shopify_subscriptions', (t) => {
    t.uuid('connection_id').notNullable().references('id').inTable('shopify_connections').onDelete('CASCADE');
    t.string('topic', 100).notNullable();
    t.string('shopify_id', 150).notNullable();
    t.text('uri').notNullable();
    t.timestamps(true, true);
    t.primary(['connection_id', 'topic']);
  });
  await knex.schema.createTable('shopify_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('connection_id').notNullable().references('id').inTable('shopify_connections').onDelete('CASCADE');
    t.string('delivery_id', 150).notNullable();
    t.string('event_id', 150);
    t.string('topic', 100).notNullable();
    t.string('resource_id', 150);
    t.string('customer_id', 150);
    t.text('payload_ciphertext');
    t.string('status', 40).notNullable().defaultTo('received');
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['connection_id', 'delivery_id']);
    t.index(['connection_id', 'received_at']);
    t.index(['connection_id', 'customer_id']);
  });
}
export async function down(knex: Knex): Promise<void> {
  for (const name of ['shopify_events', 'shopify_subscriptions', 'shopify_oauth_sessions', 'shopify_connections'])
    await knex.schema.dropTableIfExists(name);
}
