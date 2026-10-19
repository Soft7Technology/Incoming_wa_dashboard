import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE INDEX IF NOT EXISTS campaign_messages_campaign_status_idx ON campaign_messages (campaign_id, status)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS campaign_messages_campaign_status_idx');
}
