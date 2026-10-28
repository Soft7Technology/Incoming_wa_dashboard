import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('google_sheet_connections', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('access_token_ciphertext').notNullable();
    t.text('refresh_token_ciphertext').notNullable();
    t.timestamp('token_expires_at', { useTz: true }).notNullable();
    t.timestamps(true, true);
    t.unique(['company_id', 'owner_id']);
  });
  await knex.schema.createTable('google_sheet_oauth_sessions', (t) => {
    t.string('state_hash', 64).primary();
    t.string('browser_hash', 64).notNullable();
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('verifier_ciphertext').notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
    t.timestamp('consumed_at', { useTz: true });
  });
  await knex.schema.createTable('google_sheet_snapshots', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('phone_number_id').notNullable().references('id').inTable('phone_numbers');
    t.uuid('connection_id').nullable().references('id').inTable('google_sheet_connections').onDelete('SET NULL');
    t.jsonb('source').notNullable();
    t.jsonb('headers').notNullable();
    t.jsonb('rows').notNullable();
    t.jsonb('summary').notNullable();
    t.uuid('import_job_id').nullable().references('id').inTable('import_jobs');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamps(true, true);
    t.index(['company_id', 'owner_id', 'created_at']);
  });
  await knex.schema.createTable('google_sheet_campaign_requests', (t) => {
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('request_id', 120).notNullable();
    t.string('payload_hash', 64).notNullable();
    t.uuid('snapshot_id').notNullable().references('id').inTable('google_sheet_snapshots');
    t.uuid('campaign_id').nullable().references('id').inTable('campaigns').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['company_id', 'owner_id', 'request_id']);
  });
}
export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'google_sheet_campaign_requests',
    'google_sheet_snapshots',
    'google_sheet_oauth_sessions',
    'google_sheet_connections',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
