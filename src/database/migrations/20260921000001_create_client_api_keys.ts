import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('client_api_keys', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.string('name', 100).notNullable();
    table.string('key_hash', 64).notNullable().unique();
    table.string('key_prefix', 16).notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('revoked_at');
    table.index(['user_id', 'company_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('client_api_keys');
}
