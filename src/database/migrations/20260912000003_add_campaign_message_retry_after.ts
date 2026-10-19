import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('campaign_messages', 'retry_after'))) {
    await knex.schema.alterTable('campaign_messages', table => {
      table.timestamp('retry_after', { useTz: true });
    });
  }
  if (!(await knex.schema.hasColumn('campaign_messages', 'retry_attempts'))) {
    await knex.schema.alterTable('campaign_messages', table => {
      table.integer('retry_attempts').notNullable().defaultTo(0);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_messages', table => {
    table.dropColumn('retry_after');
    table.dropColumn('retry_attempts');
  });
}
