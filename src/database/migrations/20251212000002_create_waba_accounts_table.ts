import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('waba_accounts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.string('waba_id', 255).notNullable().unique(); // WhatsApp Business Account ID
    table.string('name', 255);
    table.string('currency', 10).defaultTo('USD');
    table.string('timezone', 100);
    table.string('message_template_namespace', 255);
    table.enum('status', ['active', 'inactive', 'restricted']).defaultTo('active');
    table.jsonb('meta_data'); // Additional Meta data
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.index(['company_id']);
    table.index(['waba_id']);
    table.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('waba_accounts');
}
