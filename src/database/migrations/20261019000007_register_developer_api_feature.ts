import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Fresh installations may not have had a legacy developer_api feature to backfill.
  // Keep an existing superadmin definition and its active/add-on settings unchanged.
  await knex('plan_features').insert({ key: 'developer_api', label: 'Developer API', kind: 'capacity',
    description: 'Developer API access entitlement; request quotas require separate enforcement',
    addon_allowed: false, active: true }).onConflict('key').ignore();
}

export async function down(_knex: Knex): Promise<void> {
  // Shared public catalog keys may already be used by plans; do not delete/rewrite them on rollback.
}
