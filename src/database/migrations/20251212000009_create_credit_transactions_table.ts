import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('credit_transactions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.enum('type', ['credit', 'debit', 'refund']).notNullable();
    table.decimal('amount', 15, 2).notNullable();
    table.decimal('balance_before', 15, 2).notNullable();
    table.decimal('balance_after', 15, 2).notNullable();
    table.string('reference_type', 50); // message, campaign, manual
    table.uuid('reference_id'); // ID of message/campaign/etc
    table.text('description');
    table.string('created_by', 255); // User/system who created the transaction
    table.jsonb('meta_data');
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index(['company_id']);
    table.index(['type']);
    table.index(['reference_type', 'reference_id']);
    table.index(['created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('credit_transactions');
}
