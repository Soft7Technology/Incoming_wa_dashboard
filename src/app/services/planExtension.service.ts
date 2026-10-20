import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import { CatalogActor } from './planCatalog.service';
import { markActivityRecorded } from '../utils/activityContext';
import pricing from './platformPricing.service';

const DAY_MS = 86400000;
export const EXTENSION_POLICY = Object.freeze({ min_days: 5, max_days: 30, free_days: 10 });
const conflict = (message: string, code: string, extra = {}) => {
  throw new CustomError(message, HttpStatusCode.CONFLICT, true, { code, ...extra });
};

function walletPaise(value: unknown): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  const amount = match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : NaN;
  if (!Number.isSafeInteger(amount)) throw new HTTP400Error({ message: 'Invalid company or platform wallet balance' });
  return amount;
}

function extensionStats(plan: any) {
  const used = Number(plan.extension_days);
  const fee = plan.extension_platform_fee_paise;
  if (!Number.isSafeInteger(used) || used < 0 || (fee !== null &&
      (!Number.isSafeInteger(fee) || fee < 0 || fee > 100000000)))
    conflict('Extension tracking is invalid. Apply the subscription extension policy migration before extending plans.', 'INVALID_EXTENSION_POLICY');
  return { used, fee: fee as number | null, remaining: Math.max(0, EXTENSION_POLICY.max_days - used) };
}

class PlanExtensionService {
  private authorize(actor: CatalogActor, planId: string) {
    if (!actor.userId || !['admin', 'company', 'superadmin'].includes(actor.userRole || '') ||
        actor.userRole !== 'superadmin' && !actor.companyId) {
      throw new HTTP403Error({ message: 'A company administrator is required to extend subscriptions' });
    }
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(planId))
      throw new HTTP400Error({ message: 'userPlanId must be a user_plans UUID, not a subscription catalog ID' });
  }

  async policy(actor: CatalogActor, planId: string) {
    this.authorize(actor, planId);
    return db.transaction(async trx => {
      const query = trx('user_plans').where({ id: planId });
      if (actor.userRole !== 'superadmin') query.where({ company_id: actor.companyId });
      const plan = await query.first();
      if (!plan) throw new HTTP404Error({ message: 'User plan not found in your company' });
      const owner = await trx('users').where({ id: plan.user_id, company_id: plan.company_id }).whereNull('deleted_at').first();
      if (!owner || owner.role === 'superadmin') throw new HTTP404Error({ message: 'User plan owner not found' });
      const stats = extensionStats(plan), now = Date.now();
      const start = new Date(plan.start_date).getTime(), end = new Date(plan.end_date).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        conflict('The assigned plan has invalid dates. Correct its assignment before extending it.', 'INVALID_PLAN_PERIOD');
      const eligible = owner.assigned_plan === plan.id && plan.active === true && plan.status === 'COMPLETED' &&
        start <= now;
      return { user_plan_id: plan.id, expected_end_date: new Date(plan.end_date).toISOString(), currency: 'INR',
        ...EXTENSION_POLICY, extension_days_used: stats.used, extension_days_remaining: stats.remaining,
        free_days_remaining: Math.max(0, EXTENSION_POLICY.free_days - stats.used),
        extension_fee_applied: stats.fee !== null, extension_platform_fee_paise: stats.fee,
        monthly_platform_fee_paise: await pricing.feeFor('Monthly', trx),
        fee_charge_type: 'once_per_assigned_plan_after_10_total_extension_days',
        can_extend: eligible && stats.remaining >= EXTENSION_POLICY.min_days,
        max_request_days: Math.min(EXTENSION_POLICY.max_days, stats.remaining) };
    });
  }

  async extend(actor: CatalogActor, planId: string, body: unknown) {
    this.authorize(actor, planId);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['days', 'expected_end_date', 'reason'].includes(key))) {
      throw new HTTP400Error({ message: 'Only days, expected_end_date and optional reason are accepted' });
    }
    const { days, expected_end_date, reason } = body as Record<string, unknown>;
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < EXTENSION_POLICY.min_days || days > EXTENSION_POLICY.max_days)
      throw new HTTP400Error({ message: 'days must be a whole number between 5 and 30',
        details: { code: 'INVALID_EXTENSION_DAYS', min_days: 5, max_days: 30 } });
    if (typeof expected_end_date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expected_end_date) ||
        !Number.isFinite(Date.parse(expected_end_date))) {
      throw new HTTP400Error({ message: 'expected_end_date must be the current end_date UTC timestamp returned by the user plan API' });
    }
    if (reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500))
      throw new HTTP400Error({ message: 'reason must contain 1 to 500 characters' });
    const auditReason = typeof reason === 'string' ? reason.trim() : 'Administrative subscription extension';

    const result = await db.transaction(async trx => {
      const lookup = trx('user_plans').where({ id: planId });
      if (actor.userRole !== 'superadmin') lookup.where({ company_id: actor.companyId });
      const target = await lookup.first('user_id', 'company_id', 'extension_days', 'extension_platform_fee_paise');
      if (!target) throw new HTTP404Error({ message: 'User plan not found in your company' });
      const initialStats = extensionStats(target);
      const feeMayApply = initialStats.used + days <= EXTENSION_POLICY.max_days &&
        initialStats.used + days > EXTENSION_POLICY.free_days && initialStats.fee === null;
      const quotedFee = feeMayApply ? await pricing.feeFor('Monthly', trx) : 0;
      const recipient = quotedFee > 0 ? await trx('users').where({ role: 'superadmin' }).whereNull('deleted_at').orderBy('id').first() : null;
      // Match assignment/purchase lock order: user wallets in stable order, plan, then company.
      const users = await trx('users').whereIn('id', recipient ? [target.user_id, recipient.id] : [target.user_id])
        .orderBy('id').forUpdate();
      const owner = users.find(row => row.id === target.user_id && row.company_id === target.company_id && !row.deleted_at);
      if (!owner) throw new HTTP404Error({ message: 'User plan owner not found' });
      if (owner.role === 'superadmin') throw new HTTP403Error({ message: 'Superadmin subscriptions cannot be extended here' });
      const plan = await trx('user_plans').where({ id: planId, user_id: owner.id, company_id: target.company_id })
        .forUpdate().first();
      if (!plan) throw new HTTP404Error({ message: 'User plan not found' });
      if (owner.assigned_plan !== plan.id)
        conflict('This is not the user’s current assigned plan. Refresh the subscription list.', 'PLAN_NOT_CURRENT');
      if (plan.status !== 'COMPLETED' || plan.active !== true)
        conflict('Only an active, completed subscription can be extended. Pending, cancelled or suspended plans must be resolved first.', 'PLAN_NOT_EXTENDABLE');
      const now = new Date();
      const start = new Date(plan.start_date).getTime(), oldEnd = new Date(plan.end_date).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(oldEnd) || oldEnd <= start || start > now.getTime())
        conflict('The assigned plan has invalid dates or has not started. Correct its assignment before extending it.', 'INVALID_PLAN_PERIOD');
      if (Date.parse(expected_end_date) !== oldEnd)
        conflict('The subscription end date changed. Refresh the plan before submitting another extension.',
          'PLAN_EXTENSION_CONFLICT', { current_end_date: new Date(oldEnd).toISOString() });
      const stats = extensionStats(plan);
      const totalDays = stats.used + days;
      if (totalDays > EXTENSION_POLICY.max_days)
        conflict('This assigned plan can receive at most 30 extra days in total. Reduce the extension or renew the subscription.',
          'PLAN_EXTENSION_CAP_REACHED', { max_days: 30, extension_days_used: stats.used,
            extension_days_remaining: stats.remaining, requested_days: days });
      const applyFee = totalDays > EXTENSION_POLICY.free_days && stats.fee === null;
      // An expiry precondition prevents another extension changing the fee decision while waiting for locks.
      if (applyFee !== feeMayApply) conflict('Extension details changed. Refresh the plan before extending.', 'PLAN_EXTENSION_CONFLICT');
      const feePaise = applyFee ? quotedFee : 0;
      const other = await trx('user_plans').where({ user_id: owner.id, active: true }).whereNot({ id: plan.id }).first('id');
      if (other) conflict('This user has multiple active plans. Reconcile their assignments before extending.', 'MULTIPLE_ACTIVE_PLANS');
      const base = Math.max(oldEnd, now.getTime());
      const endDate = new Date(base + days * DAY_MS);
      const durationDays = Math.ceil((endDate.getTime() - start) / DAY_MS);
      if (!Number.isFinite(endDate.getTime()) || !Number.isSafeInteger(durationDays) || durationDays > 2147483647)
        throw new HTTP400Error({ message: 'The resulting subscription period is too large' });
      if (feePaise > 0) {
        const platform = users.find(row => row.id === recipient?.id && row.role === 'superadmin' && !row.deleted_at);
        if (!platform) throw new HTTP400Error({ message: 'Platform wallet recipient is not configured for paid extensions' });
        const company = await trx('companies').where({ id: plan.company_id }).forUpdate().first();
        if (!company) throw new HTTP404Error({ message: 'Company wallet not found' });
        const before = walletPaise(company.credit_balance), platformBefore = walletPaise(platform.credit_balance ?? 0);
        if (before < feePaise) throw new HTTP400Error({ message: `Insufficient company wallet balance. Required INR ${(feePaise / 100).toFixed(2)} for this extension.`,
          details: { code: 'INSUFFICIENT_COMPANY_WALLET_BALANCE', required_paise: feePaise, available_paise: before } });
        if (!Number.isSafeInteger(platformBefore + feePaise)) throw new HTTP400Error({ message: 'Platform wallet exceeds the supported balance' });
        await trx('companies').where({ id: company.id }).update({ credit_balance: (before - feePaise) / 100 });
        await trx('users').where({ id: platform.id }).update({ credit_balance: (platformBefore + feePaise) / 100 });
        const meta = JSON.stringify({ user_plan_id: plan.id, days_added: days, extension_days_used: totalDays, platform_fee_paise: feePaise });
        await trx('credit_transactions').insert([
          { company_id: company.id, user_id: owner.id, type: 'debit', amount: -feePaise / 100,
            balance_before: before / 100, balance_after: (before - feePaise) / 100, created_by: actor.userId,
            reference_type: 'subscription_extension', reference_id: plan.id, meta_data: meta,
            description: `Platform fee for extension of ${plan.plan_name}; user plan ${plan.id}` },
          { company_id: platform.company_id, user_id: platform.id, type: 'credit', amount: feePaise / 100,
            balance_before: platformBefore / 100, balance_after: (platformBefore + feePaise) / 100, created_by: actor.userId,
            reference_type: 'subscription_extension', reference_id: plan.id, meta_data: meta,
            description: `Subscription extension fee from company ${company.id}; user plan ${plan.id}` },
        ]);
      }
      const recordedFee = applyFee ? feePaise : stats.fee;
      await trx('user_plans').where({ id: plan.id }).update({
        end_date: endDate, duration_days: durationDays, extension_days: totalDays, extension_platform_fee_paise: recordedFee,
      });
      // Packs remain valid for this assigned plan's extended lifetime. Financial terms stay intact.
      await trx('user_plan_addons').where({ user_plan_id: plan.id, user_id: owner.id, company_id: plan.company_id })
        .update({ expires_at: endDate });
      const data = { id: plan.id, user_id: owner.id, plan_name: plan.plan_name, billing_cycle: plan.billing_cycle,
        days_added: days, previous_end_date: new Date(oldEnd).toISOString(), extension_starts_at: new Date(base).toISOString(),
        start_date: new Date(start).toISOString(), end_date: endDate.toISOString(), duration_days: durationDays,
        active: plan.active, status: plan.status, currency: 'INR',
        extension_days_used: totalDays, extension_days_remaining: EXTENSION_POLICY.max_days - totalDays,
        extension_fee_paise: feePaise, extension_platform_fee_paise: recordedFee };
      await trx('activity_logs').insert({ user_id: actor.userId, company_id: plan.company_id,
        action: 'UPDATE', entity_type: 'SUBSCRIPTION', entity_id: plan.id, read: false, status: 'SUCCESS',
        description: `Extended ${plan.plan_name} subscription by ${days} days`,
        old_data: JSON.stringify({ end_date: data.previous_end_date, duration_days: plan.duration_days }),
        new_data: JSON.stringify({ ...data, reason: auditReason }),
      });
      return data;
    });
    markActivityRecorded();
    return result;
  }
}

export default new PlanExtensionService();
