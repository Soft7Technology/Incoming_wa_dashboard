import { Knex } from 'knex';

export const REPAIR_KEY = 'manual_topup_type_repair_20261028';

/** Only repair unambiguous grants: the stored balance increased by the amount. */
export function manualTopups(db: Knex | Knex.Transaction) {
  return db('credit_transactions').where({ type: 'debit', reference_type: 'manual' })
    .whereNull('user_id').where('amount', '>', 0)
    .whereRaw('balance_after - balance_before = amount')
    .whereExists(db('users as actor').select(db.raw('1')).where('actor.role', 'superadmin')
      .whereRaw('(actor.id::text = credit_transactions.created_by OR actor.id = credit_transactions.balance_transafered_by)'));
}

export async function up(db: Knex): Promise<void> {
  await manualTopups(db).update({ type: 'credit',
    meta_data: db.raw(`COALESCE(meta_data, '{}'::jsonb) || jsonb_build_object(?::text, jsonb_build_object('previous_type', type, 'repaired_at', CURRENT_TIMESTAMP))`, [REPAIR_KEY]),
  });
}

export async function down(db: Knex): Promise<void> {
  await db('credit_transactions').where({ type: 'credit', reference_type: 'manual' })
    .whereRaw("meta_data -> ?::text ->> 'previous_type' = 'debit'", [REPAIR_KEY])
    .update({ type: 'debit', meta_data: db.raw('meta_data - ?::text', [REPAIR_KEY]) });
}
