import db from '@surefy/database';
import { Knex } from 'knex';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import { featureKey, isUnmeteredFeature, usagePeriodStart } from '../utils/planFeatures';

export type PlanFeature = string;

export function checkUsage(plan: any, feature: PlanFeature, count = 1, now = new Date()) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Usage count must be a non-negative integer');
  if (isUnmeteredFeature(feature)) return { key: feature, used: 0, usage: {}, periods: {}, limit: null };
  if (!plan || !plan.active) throw new HTTP403Error({ message: 'No active subscription plan found' });
  const start = new Date(plan.start_date).getTime();
  const end = new Date(plan.end_date).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || now.getTime() < start || now.getTime() >= end) {
    throw new HTTP403Error({ message: 'Subscription plan has not started or has expired' });
  }
  const limits = typeof plan.limits === 'string' ? JSON.parse(plan.limits) : plan.limits || {};
  const usage = typeof plan.usage === 'string' ? JSON.parse(plan.usage) : { ...plan.usage };
  const key = featureKey(feature);
  const config = Object.prototype.hasOwnProperty.call(limits, key) ? limits[key] : undefined;
  if (config?.enabled === false || (plan.entitlement_version >= 2 && !config)) {
    throw new HTTP403Error({ message: `${feature} is not included in this plan` });
  }
  const baseLimit = config?.limit;
  const bonus = config?.addon_limit ?? 0;
  if (!Number.isSafeInteger(bonus) || bonus < 0) throw new HTTP403Error({ message: `Invalid ${feature} add-on limit` });
  const limit = baseLimit === null || baseLimit === undefined ? baseLimit : Number(baseLimit) + bonus;
  const periods = typeof plan.usage_periods === 'string' ? JSON.parse(plan.usage_periods) : { ...plan.usage_periods };
  const reset = config?.reset_period ?? 'never';
  if (!['never', 'monthly', 'yearly'].includes(reset)) throw new HTTP403Error({ message: `Invalid ${feature} reset period` });
  if (reset !== 'never') {
    const period = usagePeriodStart(new Date(start), now, reset);
    if ((periods[key] ?? new Date(start).toISOString()) !== period) usage[key] = 0;
    periods[key] = period;
  }
  const used = Number(usage[key] ?? 0);
  // Missing limits retain legacy unlimited behavior; explicit zero denies creation.
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(used + count) ||
      (baseLimit !== undefined && baseLimit !== null && (!Number.isSafeInteger(Number(baseLimit)) || Number(baseLimit) < 0)) ||
      (limit !== undefined && limit !== null && !Number.isSafeInteger(limit))) {
    throw new HTTP403Error({ message: `Invalid ${feature} subscription limit or usage` });
  }
  if (count > 0 && limit !== undefined && limit !== null && used + count > Number(limit)) {
    throw new HTTP403Error({ message: `${feature} plan limit reached`, details: {
      code: 'PLAN_LIMIT_EXCEEDED', feature: key, limit, used, requested: count,
      remaining: Math.max(0, Number(limit) - used), required_action: 'UPGRADE_PLAN_OR_BUY_ADDON',
    } });
  }
  return { key, used, usage, periods, limit };
}

export async function currentCapacity(trx: Knex.Transaction | Knex, userId: string, feature: string): Promise<number | undefined> {
  if (feature === 'TeamInvite') return countTeamSeats(trx as Knex.Transaction, userId);
  const tables: Record<string, string> = { Contact: 'contacts', Chatbot: 'chat_bot', WabaNumber: 'phone_numbers', AiAssistant: 'ai_assistants' };
  const table = Object.prototype.hasOwnProperty.call(tables, feature) ? tables[feature] : undefined;
  if (!table) return undefined;
  const query = trx(table).where({ user_id: userId });
  if (feature === 'Contact' || feature === 'WabaNumber') query.whereNull('deleted_at');
  if (feature === 'WabaNumber') query.where({ active: true });
  const row = await query.count('* as total').first();
  return Number(row?.total ?? 0);
}

export async function countTeamSeats(trx: Knex.Transaction, userId: string): Promise<number> {
  const row = await trx('user_team').where({ invite_sent_by: userId })
    .whereIn('invite_status', ['sent', 'accepted']).count('* as total').first();
  return Number(row?.total ?? 0);
}

export async function syncTeamSeats(trx: Knex.Transaction, userId: string) {
  const seats = await countTeamSeats(trx, userId);
  await trx('user_plans').where({ user_id: userId, active: true }).update({
    usage: trx.raw("jsonb_set(COALESCE(usage, '{}'::jsonb), '{TeamInvite}', to_jsonb(?::int))", [seats]),
  });
}

class PlanUsageService {
  /** Meta inventory can always be saved, but only entitled numbers may be active. */
  async syncWabaNumbers<T>(userId: string, save: (trx: Knex.Transaction, capacity: {
    remaining: number; inactiveReason: string;
  }) => Promise<T>): Promise<T> {
    return db.transaction(async trx => {
      await trx('users').where({ id: userId }).forUpdate().first();
      const plan = await trx('user_plans').where({ user_id: userId, active: true }).forUpdate().first();
      let limit = 0;
      let inactiveReason = 'PLAN_UNAVAILABLE';
      if (plan) {
        const used = await currentCapacity(trx, userId, 'WabaNumber');
        const usage = typeof plan.usage === 'string' ? JSON.parse(plan.usage) : plan.usage || {};
        try {
          const checked = checkUsage({ ...plan, usage: { ...usage, WabaNumber: used } }, 'WabaNumber', 0);
          limit = checked.limit == null ? Infinity : Number(checked.limit);
          inactiveReason = 'PLAN_LIMIT_EXCEEDED';
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 403) throw error;
        }
      }
      // Keep the oldest active numbers after a downgrade. Never reactivate a manually disabled number.
      const active = await trx('phone_numbers').where({ user_id: userId, active: true })
        .whereNull('deleted_at').orderBy('created_at').orderBy('id').select('id');
      const overflow = Number.isFinite(limit) ? active.slice(limit) : [];
      if (overflow.length) await trx('phone_numbers').whereIn('id', overflow.map(phone => phone.id))
        .update({ active: false, inactive_reason: inactiveReason, updated_at: new Date() });
      const result = await save(trx, { remaining: Math.max(0, limit - (active.length - overflow.length)), inactiveReason });
      if (plan) {
        await trx('user_plans').where({ id: plan.id }).update({ usage: trx.raw(
          "jsonb_set(COALESCE(usage, '{}'::jsonb), '{WabaNumber}', to_jsonb(?::int))",
          [await currentCapacity(trx, userId, 'WabaNumber')],
        ) });
      }
      return result;
    });
  }

  async run<T>(userId: string, feature: PlanFeature, create: (trx: Knex.Transaction, plan: any) => Promise<T>, count = 1): Promise<T> {
    if (isUnmeteredFeature(feature)) {
      checkUsage(null, feature, count);
      return db.transaction(trx => create(trx, null));
    }
    return db.transaction(async trx => {
      // Same lock order as assignment: owner first, then current plan.
      await trx('users').where({ id: userId }).forUpdate().first();
      const plan = await trx('user_plans').where({ user_id: userId, active: true }).forUpdate().first();
      feature = featureKey(feature);
      if (plan && (feature === 'TeamInvite' || feature === 'WabaNumber' || plan.entitlement_version >= 2)) {
        const usage = typeof plan.usage === 'string' ? JSON.parse(plan.usage) : plan.usage || {};
        const capacity = await currentCapacity(trx, userId, feature);
        if (capacity !== undefined) plan.usage = { ...usage, [feature]: capacity };
      }
      const { key, used, usage, periods } = checkUsage(plan, feature, count);
      const result = await create(trx, plan);
      const nextUsed = feature === 'WabaNumber' ? await currentCapacity(trx, userId, feature) : used + count;
      await trx('user_plans').where({ id: plan.id }).update({
        usage: JSON.stringify({ ...usage, [key]: nextUsed }),
        ...(plan.entitlement_version >= 2 ? { usage_periods: JSON.stringify(periods) } : {}),
      });
      return result;
    });
  }

  async summary(userId: string) {
    const plan = await db('user_plans').where({ user_id: userId, active: true }).first();
    checkUsage({ ...plan, limits: {}, entitlement_version: 1 }, '_validity', 0);
    const limits = typeof plan.limits === 'string' ? JSON.parse(plan.limits) : plan.limits || {};
    const usage = typeof plan.usage === 'string' ? JSON.parse(plan.usage) : { ...plan.usage };
    const features: Record<string, any> = {};
    for (const key of Object.keys(limits)) {
      if (isUnmeteredFeature(key)) continue;
      const capacity = await currentCapacity(db, userId, key);
      if (capacity !== undefined) usage[key] = capacity;
      const config = limits[key];
      // Display over-limit accounts after a downgrade rather than rejecting the summary.
      const checked = checkUsage({ ...plan, usage, limits: { ...limits, [key]: { ...config, enabled: true, limit: null } } }, key, 0);
      const total = config.enabled === false ? 0 : config.limit === null ? null : Number(config.limit) + Number(config.addon_limit ?? 0);
      features[key] = { enabled: config.enabled !== false, base_limit: config.limit, addon_limit: config.addon_limit ?? 0,
        effective_limit: total, used: checked.used, remaining: total === null ? null : Math.max(0, total - checked.used),
        reset_period: config.reset_period ?? 'never' };
    }
    return { user_plan_id: plan.id, plan_name: plan.plan_name, billing_cycle: plan.billing_cycle,
      addons: typeof plan.addons === 'string' ? JSON.parse(plan.addons) : plan.addons ?? null,
      start_date: plan.start_date, end_date: plan.end_date, features };
  }

  async assert(userId: string, feature: PlanFeature, count = 1) {
    if (isUnmeteredFeature(feature)) return checkUsage(null, feature, count);
    feature = featureKey(feature);
    const plan = await db('user_plans').where({ user_id: userId, active: true }).first();
    if (plan && (feature === 'TeamInvite' || feature === 'WabaNumber' || plan.entitlement_version >= 2)) {
      const capacity = await currentCapacity(db, userId, feature);
      if (capacity !== undefined) {
        const usage = typeof plan.usage === 'string' ? JSON.parse(plan.usage) : plan.usage || {};
        plan.usage = { ...usage, [feature]: capacity };
      }
    }
    return checkUsage(plan, feature, count);
  }
}
export default new PlanUsageService();
