import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('phone_numbers', table => {
    table.boolean('active').notNullable().defaultTo(true);
    table.string('inactive_reason', 64).nullable();
  });
  await knex('phone_numbers').where({ status: 'inactive' }).update({ active: false, inactive_reason: 'MANUALLY_DISABLED' });
  await knex.raw(`CREATE INDEX phone_numbers_owner_active_idx ON phone_numbers (user_id)
    WHERE deleted_at IS NULL AND active = true`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS phone_numbers_owner_active_idx');
  await knex.schema.alterTable('phone_numbers', table => {
    table.dropColumn('inactive_reason');
    table.dropColumn('active');
  });
}
