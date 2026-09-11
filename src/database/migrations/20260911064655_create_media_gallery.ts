import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('media_gallery', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().index();
    table.string('name', 255).notNullable();
    table.string('original_name', 255).notNullable();
    table.text('firebase_url').notNullable();
    table.string('firebase_file_name', 1000).notNullable();
    table.string('size', 50).notNullable();
    table.string('mimetype', 100).notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');
    table.index(['mimetype']);
    table.index(['created_at']);
  });
}


export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('media_gallery');
}