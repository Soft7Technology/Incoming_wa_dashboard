import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE INDEX activity_logs_company_created_idx ON activity_logs (company_id, created_at DESC, id DESC) WHERE deleted_at IS NULL');
  await knex.raw('CREATE INDEX activity_logs_user_created_idx ON activity_logs (user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL');
}
export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX activity_logs_company_created_idx');
  await knex.raw('DROP INDEX activity_logs_user_created_idx');
}
