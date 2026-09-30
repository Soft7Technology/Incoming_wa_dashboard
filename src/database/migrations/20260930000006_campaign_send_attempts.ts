import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('campaign_send_attempts', table => {
    table.uuid('company_id').notNullable();
    table.uuid('campaign_id').notNullable();
    table.uuid('phone_number_id').notNullable();
    table.string('recipient', 32).notNullable();
    table.timestamp('attempted_at').notNullable().defaultTo(knex.fn.now());
    table.primary(['company_id', 'campaign_id', 'phone_number_id', 'recipient']);
  });
  // Preserve historical messages. Every previous outbound record, including an
  // uncertain queued or failed record, consumes the one allowed attempt.
  await knex.raw(`INSERT INTO campaign_send_attempts
    (company_id, campaign_id, phone_number_id, recipient, attempted_at)
    SELECT company_id, campaign_id, phone_number_id,
      regexp_replace(to_phone, '[^0-9]', '', 'g'), MIN(created_at)
    FROM messages WHERE direction = 'outbound' AND campaign_id IS NOT NULL
      AND company_id IS NOT NULL AND phone_number_id IS NOT NULL AND to_phone IS NOT NULL
    GROUP BY company_id, campaign_id, phone_number_id, regexp_replace(to_phone, '[^0-9]', '', 'g')
    ON CONFLICT DO NOTHING`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('campaign_send_attempts');
}
