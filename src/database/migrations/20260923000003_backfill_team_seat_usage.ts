import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`UPDATE user_plans p
    SET usage = jsonb_set(COALESCE(p.usage, '{}'::jsonb), '{TeamInvite}',
      to_jsonb((SELECT count(*)::int FROM user_team t
        WHERE t.invite_sent_by = p.user_id AND t.invite_status IN ('sent', 'accepted'))))
    WHERE p.active = true`);
}

// Preserve measured seat usage on rollback; do not erase operational data.
export async function down(_knex: Knex): Promise<void> {}
