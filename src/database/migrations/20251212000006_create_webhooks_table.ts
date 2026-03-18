import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('webhooks', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.string('url', 500).notNullable();
    table.string('secret', 255);
    table.enum('status', ['active', 'inactive', 'failed']).defaultTo('active');
    table.jsonb('events').notNullable(); // Array of event types to subscribe
    table.integer('retry_count').defaultTo(0);
    table.integer('max_retries').defaultTo(3);
    table.integer('timeout_ms').defaultTo(10000);
    table.timestamp('last_triggered_at');
    table.timestamp('last_success_at');
    table.timestamp('last_failure_at');
    table.jsonb('headers'); // Custom headers
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.index(['company_id']);
    table.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('webhooks');
}
