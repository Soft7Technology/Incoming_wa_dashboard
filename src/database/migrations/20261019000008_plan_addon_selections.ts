import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('plan_addons', table => { table.string('default_key', 64).nullable().unique(); });
  // NULL preserves historical eligibility; new definitions explicitly save [] or selected packs.
  await knex.schema.alterTable('subscription_plans', table => { table.jsonb('addons').nullable(); });
  await knex.schema.alterTable('user_plans', table => { table.jsonb('addons').nullable(); });
  await knex('plan_addons').insert([
    { default_key: 'waba_number', name: 'Extra WABA number', feature_key: 'WabaNumber', units: 1, price_paise: 2000 },
    { default_key: 'chatbot', name: 'Extra chatbot', feature_key: 'Chatbot', units: 1, price_paise: 2000 },
    { default_key: 'team_member', name: 'Extra team member', feature_key: 'TeamInvite', units: 1, price_paise: 2000 },
    { default_key: 'contacts_3000', name: 'Extra 3,000 contacts', feature_key: 'Contact', units: 3000, price_paise: 2000 },
  ]).onConflict('default_key').ignore();
}

export async function down(knex: Knex): Promise<void> {
  const used = await knex('subscription_plans').whereNotNull('addons').first();
  const assigned = await knex('user_plans').whereNotNull('addons').first();
  if (used || assigned) throw new Error('Reconcile plan add-on selections before rolling back their storage');
  // Keep catalog rows and historical purchases; dropping selection storage never deletes packs.
  await knex.schema.alterTable('user_plans', table => { table.dropColumn('addons'); });
  await knex.schema.alterTable('subscription_plans', table => { table.dropColumn('addons'); });
  await knex.schema.alterTable('plan_addons', table => { table.dropColumn('default_key'); });
}
