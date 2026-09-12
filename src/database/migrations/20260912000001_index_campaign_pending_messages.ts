import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_messages', table => {
    table.index(['campaign_id', 'status'], 'campaign_messages_campaign_status_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_messages', table => {
    table.dropIndex(['campaign_id', 'status'], 'campaign_messages_campaign_status_idx');
  });
}
