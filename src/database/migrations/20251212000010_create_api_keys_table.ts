import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('api_keys', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.string('key_hash', 255).notNullable().unique();
    table.string('key_prefix', 20).notNullable(); // First few chars for identification
    table.string('name', 255).notNullable();
    table.enum('status', ['active', 'inactive', 'revoked']).defaultTo('active');
    table.jsonb('permissions'); // Array of allowed actions/resources
    table.string('ip_whitelist', 1000); // Comma-separated IPs
    table.timestamp('last_used_at');
    table.timestamp('expires_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.index(['company_id']);
    table.index(['key_hash']);
    table.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('api_keys');
}
