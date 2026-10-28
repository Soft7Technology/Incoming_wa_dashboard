import { Knex } from 'knex';

export async function up(db: Knex): Promise<void> {
  await db.schema.createTable('facebook_content_pages', (t) => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('page_id', 80).notNullable().unique();
    t.string('name').notNullable();
    t.string('facebook_user_id', 80).notNullable();
    t.string('app_id', 80).notNullable();
    t.text('token_ciphertext');
    t.jsonb('granted_permissions').notNullable();
    t.timestamp('token_expires_at', { useTz: true });
    t.timestamp('data_access_expires_at', { useTz: true });
    t.string('status', 30).notNullable().defaultTo('connected');
    t.timestamp('connected_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.index(['company_id', 'owner_id']);
  });
  await db.schema.createTable('facebook_content_oauth', (t) => {
    t.string('state_hash', 64).primary();
    t.string('browser_hash', 64).notNullable().index();
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('app_id', 80).notNullable();
    t.text('redirect_uri').notNullable();
    t.string('login_config_id', 80);
    t.string('status', 25).notNullable();
    t.string('facebook_user_id', 80);
    t.text('candidates_ciphertext');
    t.text('error');
    t.timestamp('expires_at', { useTz: true }).notNullable().index();
  });
  await db.schema.createTable('facebook_content_posts', (t) => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('page_id').notNullable().references('id').inTable('facebook_content_pages').onDelete('CASCADE');
    t.string('remote_id', 170).notNullable();
    t.text('message').notNullable().defaultTo('');
    t.string('author_id', 100);
    t.string('author_name');
    t.boolean('from_page');
    t.boolean('managed').notNullable().defaultTo(false);
    t.boolean('deleted').notNullable().defaultTo(false);
    t.text('permalink');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.unique(['page_id', 'remote_id']);
  });
  await db.schema.createTable('facebook_content_comments', (t) => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('post_id').notNullable().references('id').inTable('facebook_content_posts').onDelete('CASCADE');
    t.string('remote_id', 180).notNullable();
    t.text('message').notNullable().defaultTo('');
    t.string('author_name');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.unique(['post_id', 'remote_id']);
  });
  await db.schema.createTable('facebook_content_actions', (t) => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('page_id').notNullable().references('id').inTable('facebook_content_pages').onDelete('CASCADE');
    t.uuid('client_request_id').notNullable();
    t.string('fingerprint', 64).notNullable();
    t.string('kind', 15).notNullable();
    t.string('status', 20).notNullable();
    t.jsonb('result');
    t.text('error');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.unique(['page_id', 'client_request_id']);
  });
}

export async function down(db: Knex): Promise<void> {
  for (const table of [
    'facebook_content_actions',
    'facebook_content_comments',
    'facebook_content_posts',
    'facebook_content_oauth',
    'facebook_content_pages',
  ])
    await db.schema.dropTableIfExists(table);
}
