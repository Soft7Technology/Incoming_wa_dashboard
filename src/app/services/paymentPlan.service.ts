import { Knex } from 'knex';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { calculatePlanPeriod } from '../utils/subscriptionDuration';
import { countTeamSeats } from './planUsage.service';

export function subscriptionPricePaise(price: unknown): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(price));
  if (!match) throw new HTTP400Error({ message: 'Subscription price must be a valid INR amount with at most two decimals' });
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000) {
    throw new HTTP400Error({ message: 'Paid subscription price must be between INR 1 and INR 1000000' });
  }
  return amount;
}

class PaymentPlanService {
  async reserve(trx: Knex.Transaction, companyId: string, userId: string, planId: string) {
    const user = await trx('users').where({ id: userId, company_id: companyId }).whereNull('deleted_at').first();
    if (!user) throw new HTTP400Error({ message: 'Plan recipient must be a user in this company' });
    // Company merchant receipts can purchase only that company's catalogue, not platform plans.
    const plan = await trx('subscription_plans').where({ id: planId, company_id: companyId, active: true }).forShare().first();
    if (!plan || !['Monthly', 'Yearly'].includes(plan.billing_cycle)) {
      throw new HTTP400Error({ message: 'Select an active paid subscription from this company' });
    }
    // Read the current wallet for the authenticated company, not a client-supplied
    // balance or a historical credit transaction's balance_after. Order creation
    // already holds this company lock; keep the check inside that transaction.
    const company = await trx('companies').where({ id: companyId }).forUpdate().first();
    const rawBalance = company?.credit_balance;
    const balance = typeof rawBalance === 'number' ||
      (typeof rawBalance === 'string' && /^\d+(?:\.\d+)?$/.test(rawBalance.trim()))
      ? Number(rawBalance) : NaN;
    const requiredBalance = plan.billing_cycle === 'Yearly' ? 1000 : 100;
    if (!Number.isFinite(balance) || balance < requiredBalance) {
      throw new HTTP400Error({
        message: `Insufficient or invalid company credit balance. ${plan.billing_cycle} subscription orders require at least INR ${requiredBalance}.`,
        details: { required_balance: requiredBalance, current_balance: Number.isFinite(balance) ? balance : null },
      });
    }
    // Eligibility check only: no debit or balance_after transaction is recorded.
    const amount = subscriptionPricePaise(plan.price);
    const features = typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) throw new HTTP400Error({ message: 'Invalid plan features' });
    const limits: Record<string, any> = {}, usage: Record<string, number> = {};
    for (const key of Object.keys(features)) {
      limits[key] = { limit: features[key]?.limit_value ?? null };
      usage[key] = 0;
    }
    const now = new Date();
    const period = calculatePlanPeriod(plan, now);
    // Snapshot the purchased price/limits. Later catalogue edits must not change this purchase.
    const [pending] = await trx('user_plans').insert({
      user_id: userId, company_id: companyId, subscription_id: plan.id,
      plan_name: plan.plan_name, price: plan.price, billing_cycle: plan.billing_cycle,
      active: false, status: 'pending', start_date: now, end_date: period.endDate,
      duration_days: period.durationDays, limits: JSON.stringify(limits), usage: JSON.stringify(usage),
    }).returning('*');
    return { userPlanId: pending.id, amount };
  }

  async fulfill(trx: Knex.Transaction, order: any) {
    if (!order.user_plan_id || order.fulfilled_at || order.is_test) return;
    const pending = await trx('user_plans').where({ id: order.user_plan_id, company_id: order.company_id }).first();
    if (!pending || subscriptionPricePaise(pending.price) !== order.amount_paise) {
      throw new HTTP400Error({ message: 'Purchased plan does not match the paid order' });
    }
    const fee = pending.billing_cycle === 'Monthly' ? 100 : pending.billing_cycle === 'Yearly' ? 1000 : 0;
    if (!fee) throw new HTTP400Error({ message: 'Unsupported paid subscription billing cycle' });
    const recipient = await trx('users').where({ role: 'superadmin' }).whereNull('deleted_at').orderBy('id').first();
    if (!recipient) throw new HTTP400Error({ message: 'Platform fee recipient is not configured' });
    // Match manual assignment: lock user wallets in stable order before plan/company rows.
    const users = await trx('users').whereIn('id', [pending.user_id, recipient.id]).orderBy('id').forUpdate();
    const user = users.find(row => row.id === pending.user_id && row.company_id === order.company_id && !row.deleted_at);
    const platform = users.find(row => row.id === recipient.id && row.role === 'superadmin' && !row.deleted_at);
    if (!platform) throw new HTTP400Error({ message: 'Platform fee recipient is unavailable' });
    if (!user) throw new HTTP400Error({ message: 'Purchased plan recipient is unavailable' });
    const active = await trx('user_plans').where({ user_id: user.id, active: true }).forUpdate();
    if (active.length > 1) throw new HTTP400Error({ message: 'Multiple active plans require reconciliation' });
    if (pending.active || pending.status !== 'pending') throw new HTTP400Error({ message: 'Purchased plan is no longer pending' });
    const now = new Date();
    const period = calculatePlanPeriod(pending, now, active[0]);
    const usage = typeof pending.usage === 'string' ? JSON.parse(pending.usage) : pending.usage || {};
    usage.TeamInvite = await countTeamSeats(trx, user.id);
    // Recheck at fulfillment: another purchase may have spent credits since creation.
    // The caller locks the payment order; fulfilled_at makes this transfer exactly once.
    const company = await trx('companies').where({ id: order.company_id }).forUpdate().first();
    const parseBalance = (value: unknown) => typeof value === 'number' ||
      (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) ? Number(value) : NaN;
    const before = parseBalance(company?.credit_balance);
    const recipientBefore = parseBalance(platform.credit_balance ?? 0);
    if (!Number.isFinite(before) || before < fee || !Number.isFinite(recipientBefore) || recipientBefore < 0) {
      throw new HTTP400Error({ message: `Cannot activate paid plan: company/platform wallet balance is invalid or insufficient. Required INR ${fee}. Top up and verify the same order again; do not pay again.` });
    }
    const after = Math.round((before - fee) * 100) / 100;
    const recipientAfter = Math.round((recipientBefore + fee) * 100) / 100;
    await trx('companies').where({ id: order.company_id }).update({ credit_balance: after });
    await trx('users').where({ id: platform.id }).update({ credit_balance: recipientAfter });
    await trx('credit_transactions').insert([
      { company_id: order.company_id, user_id: user.id, type: 'debit', amount: -fee,
        balance_before: before, balance_after: after, created_by: order.user_id,
        reference_type: 'subscription_commission', description: `Platform fee for ${pending.plan_name}; payment order ${order.id}` },
      { company_id: platform.company_id, user_id: platform.id, type: 'credit', amount: fee,
        balance_before: recipientBefore, balance_after: recipientAfter, created_by: order.user_id,
        reference_type: 'subscription_commission', description: `Platform fee from company ${order.company_id}; payment order ${order.id}` },
    ]);
    if (active[0]) await trx('user_plans').where({ id: active[0].id }).update({
      active: false, status: new Date(active[0].end_date) > now ? 'CANCELLED' : 'EXPIRED',
    });
    await trx('user_plans').where({ id: pending.id }).update({
      active: true, status: 'COMPLETED', start_date: now, end_date: period.endDate,
      duration_days: period.durationDays, usage: JSON.stringify(usage),
    });
    await trx('users').where({ id: user.id }).update({ assigned_plan: pending.id, status: 'active' });
    await trx('company_payment_orders').where({ id: order.id }).update({ fulfilled_at: now });
  }
}
export default new PaymentPlanService();
