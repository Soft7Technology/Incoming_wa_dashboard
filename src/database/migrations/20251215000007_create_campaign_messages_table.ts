import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('campaign_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_id').notNullable().references('id').inTable('campaigns').onDelete('CASCADE');
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    table.uuid('message_id').references('id').inTable('messages').onDelete('SET NULL');
    table.enum('status', ['pending', 'sent', 'delivered', 'read', 'failed', 'skipped']).defaultTo('pending');
    table.text('error_message');
    table.string('error_code', 50);
    table.jsonb('template_variables'); // Resolved template variables for this contact
    table.timestamp('sent_at');
    table.timestamp('delivered_at');
    table.timestamp('read_at');
    table.timestamp('failed_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.unique(['campaign_id', 'contact_id']);
    table.index(['campaign_id']);
    table.index(['contact_id']);
    table.index(['message_id']);
    table.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('campaign_messages');
}
