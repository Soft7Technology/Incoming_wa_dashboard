import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // These tables predate the repository's migration history in existing installations.
  if (!await knex.schema.hasTable('support_tickets')) {
    await knex.schema.createTable('support_tickets', table => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.string('name', 255).notNullable();
      table.string('email', 255).notNullable();
      table.string('phone', 50);
      table.text('message').notNullable();
      table.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');
      table.uuid('company_id').references('id').inTable('companies').onDelete('CASCADE');
      table.string('status', 30).defaultTo('open');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.uuid('forward_by').references('id').inTable('users').onDelete('SET NULL');
      table.uuid('forward_superadmin').references('id').inTable('users').onDelete('SET NULL');
    });
  }
  if (!await knex.schema.hasTable('ticket_conversation')) {
    await knex.schema.createTable('ticket_conversation', table => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('ticket_id').notNullable().references('id').inTable('support_tickets').onDelete('CASCADE');
      table.text('message').notNullable();
      table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
      table.string('user_name', 255);
      table.string('user_email', 255);
      table.string('user_phone', 50);
      table.uuid('company_id').references('id').inTable('companies');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.uuid('forward_by').references('id').inTable('users').onDelete('SET NULL');
      table.uuid('forward_superadmin').references('id').inTable('users').onDelete('SET NULL');
    });
  }
  await knex.schema.alterTable('support_tickets', table => {
    table.string('subject', 255).notNullable().defaultTo('');
    table.string('channel', 20).notNullable().defaultTo('ticket');
    table.uuid('assigned_admin_id').references('id').inTable('users').onDelete('SET NULL');
    table.uuid('client_request_id');
    table.unique(['company_id', 'user_id', 'client_request_id'], { indexName: 'support_ticket_request_unique' });
    table.index(['company_id', 'updated_at', 'id'], 'support_ticket_company_updated');
    table.index(['company_id', 'user_id', 'updated_at'], 'support_ticket_owner_updated');
  });
  await knex.schema.alterTable('ticket_conversation', table => {
    table.uuid('client_message_id');
    table.bigInteger('sequence');
    table.unique(['ticket_id', 'user_id', 'client_message_id'], { indexName: 'support_message_request_unique' });
    table.index(['ticket_id', 'company_id', 'sequence'], 'support_message_ticket_sequence');
  });
  await knex.raw(`
    CREATE SEQUENCE support_message_sequence_seq AS bigint;
    WITH ordered AS (
      SELECT id, row_number() OVER (ORDER BY created_at NULLS FIRST, id) AS position FROM ticket_conversation
    ) UPDATE ticket_conversation m SET sequence = ordered.position FROM ordered WHERE m.id = ordered.id;
    SELECT setval('support_message_sequence_seq', GREATEST(COALESCE(MAX(sequence), 0), 1), COUNT(*) > 0)
      FROM ticket_conversation;
    ALTER TABLE ticket_conversation ALTER COLUMN sequence SET DEFAULT nextval('support_message_sequence_seq');
    ALTER TABLE ticket_conversation ALTER COLUMN sequence SET NOT NULL;
    ALTER SEQUENCE support_message_sequence_seq OWNED BY ticket_conversation.sequence;
  `);
  await knex.schema.createTable('support_ticket_events', table => {
    table.bigIncrements('id');
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    // Retain a minimal deletion event after a ticket and its messages have been deleted.
    table.uuid('ticket_id').notNullable();
    table.uuid('owner_id');
    table.string('type', 40).notNullable();
    table.jsonb('data').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['company_id', 'id'], 'support_event_company_cursor');
    table.index(['company_id', 'owner_id', 'id'], 'support_event_owner_cursor');
    table.index(['company_id', 'ticket_id', 'id'], 'support_event_ticket_cursor');
  });
  // Database triggers also cover the existing superadmin escalation/reply endpoints.
  // A company lock orders commits before assigning event IDs; a replay cursor cannot
  // skip an earlier transaction that was still uncommitted when a later one was read.
  await knex.raw(`
    CREATE FUNCTION support_capture_ticket_event() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE ticket support_tickets%ROWTYPE; kind text; payload jsonb;
    BEGIN
      IF TG_OP = 'DELETE' THEN ticket := OLD; ELSE ticket := NEW; END IF;
      IF ticket.company_id IS NULL THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('support:' || ticket.company_id::text, 0));
      IF TG_OP = 'DELETE' THEN
        kind := 'ticket.deleted'; payload := jsonb_build_object('ticket_id', ticket.id);
      ELSE
        kind := CASE WHEN TG_OP = 'INSERT' THEN 'ticket.created'
          WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'ticket.status_changed'
          WHEN OLD.assigned_admin_id IS DISTINCT FROM NEW.assigned_admin_id THEN 'ticket.assigned'
          ELSE 'ticket.updated' END;
        payload := jsonb_build_object('ticket', jsonb_build_object(
          'id', ticket.id, 'company_id', ticket.company_id, 'user_id', ticket.user_id,
          'subject', ticket.subject, 'channel', ticket.channel, 'status', ticket.status,
          'assigned_admin_id', ticket.assigned_admin_id, 'forward_superadmin', ticket.forward_superadmin,
          'created_at', ticket.created_at, 'updated_at', ticket.updated_at));
      END IF;
      INSERT INTO support_ticket_events(company_id, ticket_id, owner_id, type, data)
        VALUES(ticket.company_id, ticket.id, ticket.user_id, kind, payload);
      PERFORM pg_notify('support_live_events', ticket.company_id::text);
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$;
    CREATE TRIGGER support_ticket_changed AFTER INSERT OR UPDATE OR DELETE ON support_tickets
      FOR EACH ROW EXECUTE FUNCTION support_capture_ticket_event();

    CREATE FUNCTION support_capture_message_event() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE ticket support_tickets%ROWTYPE; sender_role text;
    BEGIN
      SELECT * INTO ticket FROM support_tickets WHERE id = NEW.ticket_id;
      IF ticket.company_id IS NULL THEN RETURN NEW; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('support:' || ticket.company_id::text, 0));
      SELECT role INTO sender_role FROM users WHERE id = NEW.user_id;
      INSERT INTO support_ticket_events(company_id, ticket_id, owner_id, type, data)
        VALUES(ticket.company_id, ticket.id, ticket.user_id, 'message.created', jsonb_build_object(
          'message', jsonb_build_object('id', NEW.id, 'ticket_id', NEW.ticket_id,
            'sequence', NEW.sequence::text, 'client_message_id', NEW.client_message_id,
            'message', NEW.message, 'user_id', NEW.user_id, 'user_name', NEW.user_name,
            'sender_role', sender_role, 'created_at', NEW.created_at)));
      PERFORM pg_notify('support_live_events', ticket.company_id::text);
      RETURN NEW;
    END $$;
    CREATE TRIGGER support_message_created AFTER INSERT ON ticket_conversation
      FOR EACH ROW EXECUTE FUNCTION support_capture_message_event();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS support_message_created ON ticket_conversation;
    DROP TRIGGER IF EXISTS support_ticket_changed ON support_tickets;
    DROP FUNCTION IF EXISTS support_capture_message_event();
    DROP FUNCTION IF EXISTS support_capture_ticket_event();
  `);
  await knex.schema.dropTableIfExists('support_ticket_events');
  await knex.schema.alterTable('ticket_conversation', table => {
    table.dropUnique(['ticket_id', 'user_id', 'client_message_id'], 'support_message_request_unique');
    table.dropIndex(['ticket_id', 'company_id', 'sequence'], 'support_message_ticket_sequence');
    table.dropColumn('client_message_id');
    table.dropColumn('sequence');
  });
  await knex.schema.alterTable('support_tickets', table => {
    table.dropUnique(['company_id', 'user_id', 'client_request_id'], 'support_ticket_request_unique');
    table.dropIndex(['company_id', 'updated_at', 'id'], 'support_ticket_company_updated');
    table.dropIndex(['company_id', 'user_id', 'updated_at'], 'support_ticket_owner_updated');
    table.dropColumn('subject');
    table.dropColumn('channel');
    table.dropColumn('assigned_admin_id');
    table.dropColumn('client_request_id');
  });
  // Existing tickets/messages and the pre-existing tables are intentionally preserved.
}
