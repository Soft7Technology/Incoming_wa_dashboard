import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('contact_lists', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.string('name', 255).notNullable();
    table.text('description');
    table.string('file_name', 255); // Original XLSX file name
    table.string('file_path', 500); // Stored file path
    table.jsonb('file_headers'); // XLSX headers/columns
    table.integer('total_contacts').defaultTo(0);
    table.integer('valid_contacts').defaultTo(0);
    table.integer('invalid_contacts').defaultTo(0);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.index(['company_id']);
    table.index(['created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('contact_lists');
}
