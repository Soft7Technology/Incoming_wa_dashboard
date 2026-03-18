import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('campaigns', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('phone_number_id').notNullable().references('id').inTable('phone_numbers').onDelete('CASCADE');
    table.uuid('template_id').references('id').inTable('templates').onDelete('SET NULL');
    table.string('name', 255).notNullable();
    table.text('description');
    table.enum('status', ['draft', 'scheduled', 'running', 'paused', 'completed', 'failed']).defaultTo('draft');
    table.integer('total_recipients').defaultTo(0);
    table.integer('sent_count').defaultTo(0);
    table.integer('delivered_count').defaultTo(0);
    table.integer('read_count').defaultTo(0);
    table.integer('failed_count').defaultTo(0);
    table.decimal('total_cost', 15, 2).defaultTo(0);
    table.jsonb('recipients'); // Array of phone numbers or segment criteria
    table.jsonb('template_params'); // Parameters for template
    table.timestamp('scheduled_at');
    table.timestamp('started_at');
    table.timestamp('completed_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.index(['company_id']);
    table.index(['phone_number_id']);
    table.index(['status']);
    table.index(['created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('campaigns');
}
