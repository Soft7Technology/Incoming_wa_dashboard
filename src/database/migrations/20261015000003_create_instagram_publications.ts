import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('instagram_accounts', (t) => {
    t.jsonb('granted_permissions');
  });
  await knex.schema.createTable('instagram_publish_assets', (t) => {
    t.uuid('id').primary();
    t.uuid('account_id').notNullable().references('id').inTable('instagram_accounts').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.string('filename', 80).notNullable();
    t.string('kind', 10).notNullable();
    t.text('media_url').notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
  });
  await knex.schema.createTable('instagram_publications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('account_id').notNullable().references('id').inTable('instagram_accounts').onDelete('CASCADE');
    t.uuid('client_request_id').notNullable();
    t.string('fingerprint', 64).notNullable();
    t.string('kind', 10).notNullable();
    t.text('media_url').notNullable();
    t.text('caption').notNullable();
    t.boolean('share_to_feed').notNullable().defaultTo(true);
    t.string('container_id', 80);
    t.string('media_id', 80);
    t.text('permalink');
    t.string('status', 25).notNullable().defaultTo('creating');
    t.text('error');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_checked_at', { useTz: true });
    t.unique(['account_id', 'client_request_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('instagram_publications');
  await knex.schema.dropTableIfExists('instagram_publish_assets');
  await knex.schema.alterTable('instagram_accounts', (t) => {
    t.dropColumn('granted_permissions');
  });
}
