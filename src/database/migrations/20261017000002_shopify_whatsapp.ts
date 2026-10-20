import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('shopify_whatsapp_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('connection_id').notNullable().references('id').inTable('shopify_connections').onDelete('CASCADE');
    t.string('topic', 100).notNullable();
    t.boolean('enabled').notNullable().defaultTo(false);
    t.uuid('phone_number_id').references('id').inTable('phone_numbers').onDelete('SET NULL');
    t.uuid('template_id').references('id').inTable('templates').onDelete('SET NULL');
    t.jsonb('parameter_mapping').notNullable().defaultTo('{}');
    t.string('consent_attribute', 80).notNullable().defaultTo('soft7_whatsapp_opt_in');
    t.uuid('revision').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.timestamps(true, true);
    t.unique(['connection_id', 'topic']);
  });
  await knex.schema.createTable('shopify_whatsapp_jobs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('connection_id').notNullable().references('id').inTable('shopify_connections').onDelete('CASCADE');
    t.uuid('rule_id').references('id').inTable('shopify_whatsapp_rules').onDelete('SET NULL');
    t.uuid('rule_revision').notNullable();
    t.uuid('event_id').references('id').inTable('shopify_events').onDelete('SET NULL');
    t.string('dedupe_key', 64).notNullable();
    t.string('topic', 100).notNullable();
    t.string('resource_id', 150);
    t.string('status', 30).notNullable();
    t.string('reason', 80);
    t.jsonb('subject_hashes').notNullable().defaultTo('[]');
    t.text('payload_ciphertext');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('started_at', { useTz: true });
    t.timestamp('finished_at', { useTz: true });
    t.timestamp('send_before', { useTz: true }).notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
    t.unique(['connection_id', 'dedupe_key']);
    t.index(['status', 'created_at']);
    t.index(['connection_id', 'created_at']);
  });
  await knex.raw('create index shopify_whatsapp_jobs_subjects_idx on shopify_whatsapp_jobs using gin (subject_hashes)');
  // Shopify-derived message history follows erasure/expiry of its source job.
  await knex.schema.alterTable('messages', (t) => {
    t.uuid('shopify_job_id').references('id').inTable('shopify_whatsapp_jobs').onDelete('CASCADE').index();
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (t) => t.dropColumn('shopify_job_id'));
  await knex.schema.dropTableIfExists('shopify_whatsapp_jobs');
  await knex.schema.dropTableIfExists('shopify_whatsapp_rules');
}
