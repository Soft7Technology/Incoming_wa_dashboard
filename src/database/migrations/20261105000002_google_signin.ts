import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', table => {
    table.string('password', 255).nullable().alter();
  });
  await knex.schema.createTable('google_auth_identities', table => {
    table.string('google_sub', 255).primary();
    table.uuid('user_id').notNullable().unique().references('id').inTable('users').onDelete('CASCADE');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('google_auth_sessions', table => {
    table.string('token_hash', 64).primary();
    table.string('nonce', 64).notNullable();
    table.text('origin').notNullable();
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('purpose', 10).notNullable();
    table.string('ip_hash', 64).notNullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('expires_at', { useTz: true }).notNullable().index();
    table.timestamp('consumed_at', { useTz: true }).nullable();
    table.index(['ip_hash', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Never invent passwords or remove the only login method during rollback.
  if (await knex('google_auth_identities').first('user_id') || await knex('users').whereNull('password').first('id')) {
    throw new Error('Google sign-in has users. Migrate their login methods before rolling back.');
  }
  await knex.schema.dropTable('google_auth_sessions');
  await knex.schema.dropTable('google_auth_identities');
  await knex.schema.alterTable('users', table => {
    table.string('password', 255).notNullable().alter();
  });
}
