import { Knex } from 'knex';

export const PLATFORM_FEE_TYPES = ['subscription_commission', 'subscription_extension', 'plan_addon'];

/** A company wallet and its superadmin's user wallet may share a company ID. */
export function companyWallet(query: Knex.QueryBuilder, db: Knex | Knex.Transaction) {
  return query.whereNotExists(db('users as wallet_owner').select(db.raw('1'))
    .whereRaw('wallet_owner.id = credit_transactions.user_id').where('wallet_owner.role', 'superadmin'));
}

export function platformFees(query: Knex.QueryBuilder, db: Knex | Knex.Transaction) {
  return query.where('type', 'credit').whereIn('reference_type', PLATFORM_FEE_TYPES)
    .whereExists(db('users as wallet_owner').select(db.raw('1'))
      .whereRaw('wallet_owner.id = credit_transactions.user_id').where('wallet_owner.role', 'superadmin'));
}
