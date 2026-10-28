import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('waba_onboardings', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users');
    table.uuid('company_id').notNullable().references('id').inTable('companies');
    table.string('code_hash', 64).notNullable().unique();
    table.string('idempotency_key', 100).nullable();
    table.string('requested_waba_id', 255).nullable();
    table.string('requested_phone_id', 255).nullable();
    table.string('resolved_waba_id', 255).nullable();
    table.uuid('waba_record_id').nullable().references('id').inTable('waba_accounts');
    table.string('status', 32).notNullable().defaultTo('exchanging_code');
    table.string('step', 32).notNullable().defaultTo('code_exchange');
    table.text('token_encrypted').nullable();
    table.timestamp('token_expires_at', { useTz: true }).nullable();
    table.jsonb('authorized_wabas').notNullable().defaultTo('[]');
    table.jsonb('progress').notNullable().defaultTo('{}');
    table.integer('attempts').notNullable().defaultTo(0);
    table.integer('max_attempts').notNullable().defaultTo(6);
    table.uuid('lease_token').nullable();
    table.timestamp('lease_expires_at', { useTz: true }).nullable();
    table.timestamp('next_attempt_at', { useTz: true }).nullable();
    table.string('error_code', 80).nullable();
    table.text('error_message').nullable();
    table.boolean('retryable').notNullable().defaultTo(false);
    table.timestamp('connected_at', { useTz: true }).nullable();
    table.timestamps(true, true);
    table.unique(['company_id', 'user_id', 'idempotency_key']);
    table.index(['status', 'next_attempt_at']);
    table.index(['resolved_waba_id']);
  });
  await knex.schema.createTable('waba_onboarding_states', table => {
    table.string('state_hash', 64).primary();
    table.uuid('user_id').notNullable().references('id').inTable('users');
    table.uuid('company_id').notNullable().references('id').inTable('companies');
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.uuid('onboarding_id').nullable().references('id').inTable('waba_onboardings');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('waba_credentials', table => {
    table.uuid('waba_record_id').primary().references('id').inTable('waba_accounts');
    table.uuid('user_id').notNullable().references('id').inTable('users');
    table.uuid('company_id').notNullable().references('id').inTable('companies');
    table.uuid('onboarding_id').notNullable().references('id').inTable('waba_onboardings');
    table.text('token_encrypted').notNullable();
    table.timestamp('expires_at', { useTz: true }).nullable();
    table.timestamps(true, true);
  });
  await knex.schema.createTable('waba_account_events', table => {
    table.string('event_hash', 64).primary();
    table.string('waba_id', 255).notNullable();
    table.string('event', 80).notNullable();
    table.timestamp('event_at', { useTz: true }).nullable();
    // Never persist arbitrary webhook bodies or credentials from incoming events.
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['waba_id', 'created_at']);
  });
  await knex.schema.alterTable('waba_accounts', table => {
    // Legacy is intentionally not a claim that old webhook/registration setup was verified.
    table.string('connection_status', 32).notNullable().defaultTo('legacy');
    table.timestamp('connected_at', { useTz: true }).nullable();
    table.timestamp('last_synced_at', { useTz: true }).nullable();
    table.uuid('current_onboarding_id').nullable();
    table.timestamp('onboarding_started_at', { useTz: true }).nullable();
  });
  await knex.schema.alterTable('phone_numbers', table => {
    table.string('connection_status', 32).notNullable().defaultTo('legacy');
  });
}

export async function down(knex: Knex): Promise<void> {
  const credentials = await knex('waba_credentials').count('* as total').first();
  if (Number(credentials?.total)) throw new Error('Export/reconcile connected WABA credentials before rolling back Embedded Signup storage');
  await knex.schema.alterTable('waba_accounts', table => {
    table.dropColumn('current_onboarding_id'); table.dropColumn('onboarding_started_at');
    table.dropColumn('last_synced_at'); table.dropColumn('connected_at'); table.dropColumn('connection_status');
  });
  await knex.schema.alterTable('phone_numbers', table => { table.dropColumn('connection_status'); });
  await knex.schema.dropTable('waba_account_events');
  await knex.schema.dropTable('waba_credentials');
  await knex.schema.dropTable('waba_onboarding_states');
  await knex.schema.dropTable('waba_onboardings');
}
