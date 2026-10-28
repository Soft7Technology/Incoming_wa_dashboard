import { Knex } from 'knex';

export async function up(db: Knex) {
  await db.schema.createTable('automation_connections', t => {
    t.uuid('id').primary(); t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('app_key', 40).notNullable(); t.string('name', 120).notNullable(); t.string('mode', 10).notNullable();
    t.text('credentials_ciphertext').notNullable(); t.string('status', 20).notNullable().defaultTo('connected');
    t.timestamps(true, true); t.index(['company_id', 'user_id']);
  });
  await db.schema.createTable('automation_flows', t => {
    t.uuid('id').primary(); t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('name', 120).notNullable(); t.string('status', 20).notNullable().defaultTo('draft');
    t.integer('revision').notNullable().defaultTo(1); t.jsonb('steps').notNullable();
    t.string('webhook_token_hash', 64).notNullable(); t.text('webhook_token_ciphertext').notNullable(); t.text('webhook_secret_ciphertext');
    t.timestamp('deleted_at', { useTz: true }); t.timestamps(true, true);
    t.index(['company_id', 'user_id', 'created_at']);
  });
  await db.schema.createTable('automation_events', t => {
    t.uuid('id').primary(); t.uuid('flow_id').notNullable().references('id').inTable('automation_flows').onDelete('CASCADE');
    t.string('app_key', 40).notNullable(); t.uuid('connection_id').notNullable(); t.jsonb('subject_hashes').notNullable().defaultTo('[]');
    t.string('source_event_id', 200).notNullable(); t.string('topic', 100).notNullable();
    t.text('payload_ciphertext').notNullable(); t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable().defaultTo(db.raw("CURRENT_TIMESTAMP + INTERVAL '30 days'"));
    t.unique(['flow_id', 'source_event_id']); t.index(['flow_id', 'received_at']); t.index(['app_key', 'connection_id']); t.index(['expires_at']);
  });
  await db.schema.createTable('automation_runs', t => {
    t.uuid('id').primary(); t.uuid('flow_id').notNullable().references('id').inTable('automation_flows').onDelete('CASCADE');
    t.uuid('event_id').notNullable().references('id').inTable('automation_events').onDelete('CASCADE');
    t.uuid('request_id').notNullable(); t.string('kind', 10).notNullable(); t.integer('revision').notNullable();
    t.string('status', 30).notNullable().defaultTo('queued'); t.jsonb('definition').notNullable();
    t.text('results_ciphertext'); t.string('error', 500); t.timestamp('started_at', { useTz: true }); t.timestamp('finished_at', { useTz: true });
    t.timestamps(true, true); t.unique(['flow_id', 'request_id']); t.index(['status', 'created_at']); t.index(['flow_id', 'created_at']);
  });
}
export async function down(db: Knex) {
  for (const table of ['automation_runs', 'automation_events', 'automation_flows', 'automation_connections']) await db.schema.dropTableIfExists(table);
}
