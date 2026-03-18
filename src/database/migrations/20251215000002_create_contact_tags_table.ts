import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('contact_tags', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.string('name', 100).notNullable();
    table.string('color', 7).defaultTo('#3B82F6'); // Hex color for UI
    table.text('description');
    table.integer('contact_count').defaultTo(0); // Denormalized count
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.unique(['company_id', 'name']);
    table.index(['company_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('contact_tags');
}
