import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('contact_tag_relations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    table.uuid('tag_id').notNullable().references('id').inTable('contact_tags').onDelete('CASCADE');
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.unique(['contact_id', 'tag_id']);
    table.index(['contact_id']);
    table.index(['tag_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('contact_tag_relations');
}
