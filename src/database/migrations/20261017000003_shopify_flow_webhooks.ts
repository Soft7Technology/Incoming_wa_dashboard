import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('shopify_flow_webhooks', (t) => {
    t.uuid('flow_id').primary().references('id').inTable('chat_bot').onDelete('CASCADE');
    t.uuid('connection_id').notNullable().references('id').inTable('shopify_connections').onDelete('CASCADE');
    t.string('topic', 100).notNullable();
    t.string('token_hash', 64).notNullable();
    t.text('token_ciphertext');
    t.text('signing_secret_ciphertext');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['connection_id']);
  });
  await knex.schema.alterTable('shopify_events', (t) => {
    t.uuid('flow_id').references('id').inTable('chat_bot').onDelete('SET NULL');
    t.index(['flow_id', 'received_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('shopify_events', (t) => {
    t.dropIndex(['flow_id', 'received_at']);
    t.dropColumn('flow_id');
  });
  await knex.schema.dropTable('shopify_flow_webhooks');
}
