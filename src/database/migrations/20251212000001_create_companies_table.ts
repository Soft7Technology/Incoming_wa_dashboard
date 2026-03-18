import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('companies', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 255).notNullable();
    table.string('email', 255).notNullable().unique();
    table.string('phone', 50);
    table.string('business_id', 255); // Meta Business ID
    table.string('api_key', 255).unique();
    table.string('webhook_url', 500);
    table.string('webhook_verify_token', 255);
    table.enum('status', ['active', 'inactive', 'suspended']).defaultTo('active');
    table.decimal('credit_balance', 15, 2).defaultTo(0);
    table.jsonb('meta_config'); // Store Meta-specific configurations
    table.jsonb('settings'); // Additional settings
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.index(['status']);
    table.index(['api_key']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('companies');
}
