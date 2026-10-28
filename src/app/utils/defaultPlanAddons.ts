import { Knex } from 'knex';

export function defaultPlanAddons() {
  return [
    { default_key: 'waba_number', name: 'Extra WABA number', feature_key: 'WabaNumber', units: 1, price_paise: 2000 },
    { default_key: 'chatbot', name: 'Extra chatbot', feature_key: 'Chatbot', units: 1, price_paise: 2000 },
    { default_key: 'team_member', name: 'Extra team member', feature_key: 'TeamInvite', units: 1, price_paise: 2000 },
    { default_key: 'contacts_3000', name: 'Extra 3,000 contacts', feature_key: 'Contact', units: 3000, price_paise: 2000 },
  ];
}

/** Shared superadmin catalog: initialize once, never overwrite a price/status edited later. */
export async function ensureDefaultPlanAddons(trx: Knex.Transaction) {
  const defaults = defaultPlanAddons();
  await trx('plan_addons').insert(defaults).onConflict('default_key').ignore();
  return trx('plan_addons').whereIn('default_key', defaults.map(row => row.default_key)).orderBy('default_key');
}
