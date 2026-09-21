import { Knex } from 'knex';

// Keep the original migration intact so already-deployed databases can upgrade.
// Renaming preserves every existing key, hash, foreign key, and unique constraint.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.renameTable('client_api_keys', 'user_api_keys');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.renameTable('user_api_keys', 'client_api_keys');
}
