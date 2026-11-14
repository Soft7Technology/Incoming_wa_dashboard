import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_request_logs', table => {
    table.uuid('id').primary();
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('api_key_id').references('id').inTable('user_api_keys').onDelete('SET NULL');
    table.string('key_prefix', 16);
    table.string('method', 16).notNullable();
    table.text('endpoint').notNullable();
    table.jsonb('query');
    table.jsonb('request_body');
    table.jsonb('response_body');
    table.integer('http_status');
    table.string('outcome', 16).notNullable().defaultTo('pending');
    table.integer('duration_ms');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('completed_at', { useTz: true });
    table.index(['company_id', 'user_id', 'created_at', 'id'], 'api_logs_owner_created_idx');
    table.index(['api_key_id', 'created_at']);
  });
  await knex.schema.createTable('api_request_messages', table => {
    // Reserved before sending; a messages row may not exist yet or validation may fail.
    table.uuid('id').primary();
    table.uuid('request_id').notNullable().references('id').inTable('api_request_logs').onDelete('CASCADE');
    table.jsonb('request_body');
    table.string('status', 16).notNullable().defaultTo('queued');
    table.text('error_message');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['request_id', 'created_at', 'id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('api_request_messages');
  await knex.schema.dropTable('api_request_logs');
}
