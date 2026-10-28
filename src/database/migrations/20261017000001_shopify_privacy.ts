import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('shopify_events', (t) => {
    t.integer('payload_version').notNullable().defaultTo(0);
    t.jsonb('subject_hashes').notNullable().defaultTo('[]');
    t.timestamp('expires_at', { useTz: true }).index();
  });
  await knex.raw("update shopify_events set expires_at = received_at + interval '30 days'");
  await knex.raw('create index shopify_events_subject_hashes_idx on shopify_events using gin (subject_hashes)');
  await knex.schema.createTable('shopify_privacy_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('connection_id').notNullable().references('id').inTable('shopify_connections').onDelete('CASCADE');
    t.string('delivery_id', 150).notNullable();
    t.string('topic', 100).notNullable();
    t.text('payload_ciphertext');
    t.jsonb('subject_hashes').notNullable().defaultTo('[]');
    t.string('status', 30).notNullable().defaultTo('pending');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('due_at', { useTz: true }).notNullable();
    t.timestamp('exported_at', { useTz: true });
    t.timestamp('completed_at', { useTz: true });
    t.uuid('completed_by');
    t.unique(['connection_id', 'delivery_id']);
    t.index(['connection_id', 'status', 'due_at']);
  });
  await knex.schema.createTable('shopify_redactions', (t) => {
    t.uuid('connection_id').notNullable().references('id').inTable('shopify_connections').onDelete('CASCADE');
    t.string('subject_hash', 64).notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
    t.primary(['connection_id', 'subject_hash']);
  });
  await knex.schema.createTable('shopify_data_access_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('connection_id').notNullable().references('id').inTable('shopify_connections').onDelete('CASCADE');
    t.uuid('actor_id').notNullable();
    t.string('action', 40).notNullable();
    t.uuid('target_id').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now()).index();
  });
}
export async function down(knex: Knex): Promise<void> {
  for (const name of ['shopify_data_access_log', 'shopify_redactions', 'shopify_privacy_requests'])
    await knex.schema.dropTableIfExists(name);
  await knex.raw('drop index if exists shopify_events_subject_hashes_idx');
  await knex.schema.alterTable('shopify_events', (t) =>
    t.dropColumns('payload_version', 'subject_hashes', 'expires_at'),
  );
}
