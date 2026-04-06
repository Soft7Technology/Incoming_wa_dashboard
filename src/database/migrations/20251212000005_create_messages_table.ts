import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('phone_number_id').notNullable().references('id').inTable('phone_numbers').onDelete('CASCADE');
    table.string('wamid', 255).unique(); // WhatsApp Message ID
    table.enum('direction', ['inbound', 'outbound']).notNullable();
    table.enum('type', ['text', 'image', 'video', 'document', 'audio', 'template', 'interactive', 'location', 'contacts', 'sticker']).notNullable();
    table.string('from_phone', 50).notNullable();
    table.string('to_phone', 50).notNullable();
    table.enum('status', ['queued', 'sent', 'delivered', 'read', 'failed', 'deleted','received']).defaultTo('queued');
    table.text('error_message');
    table.string('error_code', 50);
    table.jsonb('content'); // Message content (text, media URLs, etc.)
    table.jsonb('context'); // Reply context
    table.uuid('template_id').references('id').inTable('templates').onDelete('SET NULL');
    table.uuid('campaign_id'); // Reference to campaigns if part of bulk send
    table.decimal('cost', 10, 4).defaultTo(0); // Message cost
    table.timestamp('queued_at');
    table.timestamp('sent_at');
    table.timestamp('delivered_at');
    table.timestamp('read_at');
    table.timestamp('failed_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.index(['company_id']);
    table.index(['phone_number_id']);
    table.index(['wamid']);
    table.index(['direction']);
    table.index(['status']);
    table.index(['from_phone']);
    table.index(['to_phone']);
    table.index(['created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('messages');
}
