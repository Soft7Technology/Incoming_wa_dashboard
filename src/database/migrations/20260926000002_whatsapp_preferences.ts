import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('whatsapp_preference_events', table => {
    table.bigIncrements('id');
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('RESTRICT');
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    table.string('recipient', 15).notNullable(); // Stable company-wide identity, independent of sending number.
    table.enum('scope', ['all', 'marketing']).notNullable();
    table.enum('previous_status', ['opted_in', 'opted_out']).nullable();
    table.enum('new_status', ['opted_in', 'opted_out']).notNullable();
    table.string('source', 50).notNullable();
    table.jsonb('evidence').notNullable();
    table.string('wamid', 255);
    table.uuid('staff_user_id'); // Immutable snapshot: deleting a staff account must not rewrite history.
    table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['company_id', 'wamid', 'scope']);
    table.index(['company_id', 'recipient', 'id']);
  });
  await knex.schema.createTable('whatsapp_preferences', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('RESTRICT');
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    table.string('recipient', 15).notNullable();
    table.enum('scope', ['all', 'marketing']).notNullable();
    table.enum('status', ['opted_in', 'opted_out']).notNullable();
    table.string('source', 50).notNullable();
    table.jsonb('evidence').notNullable();
    table.bigInteger('event_id').notNullable().references('id').inTable('whatsapp_preference_events');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['company_id', 'contact_id', 'scope']);
    table.index(['company_id', 'recipient', 'scope', 'event_id']);
  });
  await knex.schema.createTable('whatsapp_inbound_receipts', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable();
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    table.uuid('phone_number_id').notNullable();
    table.string('recipient', 15).notNullable();
    table.string('wamid', 255).notNullable();
    table.string('command', 20);
    table.boolean('handled').notNullable().defaultTo(false);
    table.text('reply_text');
    table.enum('reply_status', ['none', 'pending', 'sending', 'sent', 'failed']).notNullable().defaultTo('none');
    table.uuid('reply_token');
    table.string('reply_wamid', 255);
    table.text('reply_error');
    table.timestamp('received_at', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['company_id', 'wamid']);
  });
  await knex.schema.createTable('whatsapp_consent_requests', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable();
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    table.uuid('phone_number_id').notNullable();
    table.string('recipient', 15).notNullable();
    table.string('request_wamid', 255).notNullable();
    table.enum('scope', ['all', 'marketing']).notNullable();
    table.text('terms').notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('consumed_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['company_id', 'request_wamid']);
  });
  await knex.raw(`CREATE FUNCTION reject_whatsapp_preference_event_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'WhatsApp preference events are append-only'; END;
    $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER whatsapp_preference_events_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON whatsapp_preference_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_whatsapp_preference_event_mutation()`);
  await knex.raw('ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check');
  await knex.raw(`ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK
    (status IN ('queued','sent','delivered','read','failed','deleted','received','suppressed'))`);
  await knex.raw(`CREATE INDEX whatsapp_support_window_idx ON messages
    (company_id, phone_number_id, from_phone, created_at DESC) WHERE direction = 'inbound'`);
}

export async function down(): Promise<void> {
  throw new Error('Preference audit history must be retained. Roll back application code without dropping consent records.');
}
