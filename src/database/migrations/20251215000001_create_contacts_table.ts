import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('contacts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.string('phone_number', 50).notNullable();
    table.string('name', 255);
    table.string('email', 255);
    table.jsonb('attributes'); // Dynamic attributes (any custom fields from XLSX)
    table.boolean('is_valid').defaultTo(true); // WhatsApp number validity
    table.enum('invalid_reason', ['not_whatsapp', 'invalid_format', 'blocked', 'opted_out', 'other']);
    table.text('notes');
    table.integer('message_count').defaultTo(0); // Total messages sent to this contact
    table.integer('failed_count').defaultTo(0); // Total failed messages
    table.timestamp('last_contacted_at');
    table.timestamp('last_invalid_at'); // When marked as invalid
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.unique(['company_id', 'phone_number']);
    table.index(['company_id']);
    table.index(['phone_number']);
    table.index(['is_valid']);
    table.index(['created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('contacts');
}
