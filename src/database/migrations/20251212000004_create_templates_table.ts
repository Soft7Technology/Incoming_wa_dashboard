import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('templates', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('waba_id').notNullable().references('id').inTable('waba_accounts').onDelete('CASCADE');
    table.string('template_id', 255); // Meta Template ID
    table.string('name', 255).notNullable();
    table.string('language', 10).notNullable();
    table.enum('category', ['AUTHENTICATION', 'MARKETING', 'UTILITY']).notNullable();
    table.enum('status', ['APPROVED', 'PENDING','PAUSED', 'REJECTED', 'DISABLED']).defaultTo('PENDING');
    table.text('rejection_reason');
    table.jsonb('components'); // Template structure (header, body, footer, buttons)
    table.jsonb('meta_data');
    table.timestamp('synced_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.index(['company_id']);
    table.index(['waba_id']);
    table.index(['template_id']);
    table.index(['status']);
    table.unique(['company_id', 'name', 'language']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('templates');
}
