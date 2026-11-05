import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('waba_accounts', table => {
    table.string('whatsapp_business_manager_messaging_limit', 64).nullable();
    table.timestamp('messaging_limit_synced_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('waba_accounts', table => {
    table.dropColumn('whatsapp_business_manager_messaging_limit');
    table.dropColumn('messaging_limit_synced_at');
  });
}
