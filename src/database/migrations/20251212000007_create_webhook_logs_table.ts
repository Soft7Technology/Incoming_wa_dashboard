import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('webhook_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('webhook_id').notNullable().references('id').inTable('webhooks').onDelete('CASCADE');
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.string('event_type', 100).notNullable();
    table.jsonb('payload').notNullable();
    table.enum('status', ['pending', 'success', 'failed', 'retry']).defaultTo('pending');
    table.integer('attempt_count').defaultTo(0);
    table.integer('response_status_code');
    table.text('response_body');
    table.text('error_message');
    table.integer('duration_ms');
    table.timestamp('sent_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.index(['webhook_id']);
    table.index(['company_id']);
    table.index(['status']);
    table.index(['event_type']);
    table.index(['created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('webhook_logs');
}
