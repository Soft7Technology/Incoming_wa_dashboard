import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex.raw("SET LOCAL statement_timeout = '60s'");
  await knex.schema.alterTable('user_plans', table => {
    table.integer('extension_days').notNullable().defaultTo(0);
    // NULL = fee not yet applied; 0 = the superadmin explicitly waived it.
    table.integer('extension_platform_fee_paise').nullable();
  });
  await knex.raw(`ALTER TABLE user_plans ADD CONSTRAINT user_plans_extension_policy_valid CHECK (
    extension_days >= 0 AND (extension_platform_fee_paise IS NULL OR extension_platform_fee_paise BETWEEN 0 AND 100000000)
  )`);
  // Count extensions already granted by this API. Never change their existing dates,
  // charge retrospectively, or infer extra days from renewals/carried paid time.
  await knex.raw(`UPDATE user_plans p SET extension_days = history.days
    FROM (
      SELECT p0.id, sum(CASE WHEN (a.new_data->>'days_added') ~ '^[0-9]{1,4}$'
        THEN (a.new_data->>'days_added')::integer ELSE 0 END)::integer days
      FROM user_plans p0 JOIN activity_logs a ON a.entity_id::text = p0.id::text
      WHERE a.entity_type = 'SUBSCRIPTION' AND a.action = 'UPDATE' AND a.status = 'SUCCESS'
        AND a.new_data->>'id' = p0.id::text AND a.new_data->>'user_id' = p0.user_id::text
        AND jsonb_exists(a.new_data, 'previous_end_date') AND jsonb_exists(a.new_data, 'extension_starts_at')
        AND (a.new_data->>'days_added') ~ '^[0-9]{1,4}$'
        AND CASE WHEN (a.new_data->>'days_added') ~ '^[0-9]{1,4}$'
          THEN (a.new_data->>'days_added')::integer ELSE 0 END BETWEEN 1 AND 3650
      GROUP BY p0.id
    ) history WHERE p.id = history.id`);
}

export async function down(knex: Knex): Promise<void> {
  const used = await knex('activity_logs').where({ entity_type: 'SUBSCRIPTION', action: 'UPDATE', status: 'SUCCESS' })
    .whereRaw("jsonb_exists(new_data, 'extension_days_used')").first('entity_id');
  if (used) throw new Error('Reconcile extensions and their wallet transfers before removing extension policy tracking');
  await knex.raw('ALTER TABLE user_plans DROP CONSTRAINT user_plans_extension_policy_valid');
  await knex.schema.alterTable('user_plans', table => {
    table.dropColumn('extension_days'); table.dropColumn('extension_platform_fee_paise');
  });
}
