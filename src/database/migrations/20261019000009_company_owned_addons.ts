import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('plan_addons', table => {
    // Existing NULL ownership remains the shared superadmin catalog.
    table.uuid('company_id').nullable().references('id').inTable('companies').onDelete('RESTRICT');
    table.uuid('created_by').nullable().references('id').inTable('users').onDelete('RESTRICT');
    table.index(['company_id', 'active']);
  });
  await knex.raw('ALTER TABLE plan_addons ALTER COLUMN price_paise SET DEFAULT 2000');
}

export async function down(knex: Knex): Promise<void> {
  const owned = await knex('plan_addons').whereNotNull('company_id').first();
  if (owned) throw new Error('Reconcile company-owned add-ons before removing ownership isolation');
  await knex.raw('ALTER TABLE plan_addons ALTER COLUMN price_paise DROP DEFAULT');
  await knex.schema.alterTable('plan_addons', table => {
    table.dropIndex(['company_id', 'active']); table.dropColumn('created_by'); table.dropColumn('company_id');
  });
}
