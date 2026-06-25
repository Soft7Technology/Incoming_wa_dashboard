import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('ai_assistants', (table) => {
    table.increments('id').primary(); // Autoincrementing integer ID matching frontend expectations
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.string('name', 255).notNullable();
    table.string('role', 255).notNullable();
    table.enum('status', ['ACTIVE', 'INACTIVE']).defaultTo('ACTIVE');
    table.string('prompt_type', 100).notNullable(); // 'predefined' or 'custom'
    table.text('predefined_prompt');
    table.text('custom_prompt');
    table.string('provider', 100).notNullable();
    table.string('model', 100).notNullable();
    table.string('api_key', 500);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.index(['user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('ai_assistants');
}
