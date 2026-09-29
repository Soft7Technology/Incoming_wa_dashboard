import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.transaction(async trx => {
    await trx.raw('LOCK TABLE user_api_keys IN SHARE ROW EXCLUSIVE MODE');
    await trx.raw(`
      WITH ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) AS position
        FROM user_api_keys WHERE revoked_at IS NULL
      )
      UPDATE user_api_keys AS k SET revoked_at = NOW()
      FROM ranked AS r WHERE k.id = r.id AND r.position > 1
    `);
    await trx.raw(`CREATE UNIQUE INDEX user_api_keys_one_active_per_user
      ON user_api_keys (user_id) WHERE revoked_at IS NULL`);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Previously revoked credentials stay revoked on rollback.
  await knex.raw('DROP INDEX user_api_keys_one_active_per_user');
}
