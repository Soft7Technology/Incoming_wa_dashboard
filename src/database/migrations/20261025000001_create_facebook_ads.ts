import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('facebook_ads_connections', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('facebook_user_id', 80).notNullable().index();
    t.text('token_ciphertext').notNullable();
    t.jsonb('permissions').notNullable();
    t.timestamp('data_expires_at', { useTz: true });
    t.timestamp('connected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['company_id', 'owner_id']);
  });
  await knex.schema.createTable('facebook_ads_oauth', t => {
    t.string('state_hash', 64).primary();
    t.string('browser_hash', 64).notNullable();
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('status', 40).notNullable().defaultTo('started');
    t.text('error');
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
  });
  await knex.schema.createTable('facebook_ads_actions', t => {
    t.uuid('id').primary();
    t.uuid('connection_id').notNullable().references('id').inTable('facebook_ads_connections').onDelete('CASCADE');
    t.string('account_id', 80).notNullable();
    t.string('request_hash', 64).notNullable();
    t.string('campaign_id', 80);
    t.string('status', 40).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['facebook_ads_actions', 'facebook_ads_oauth', 'facebook_ads_connections'])
    await knex.schema.dropTableIfExists(table);
}
