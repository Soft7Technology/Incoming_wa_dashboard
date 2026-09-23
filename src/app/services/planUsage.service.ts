import db from '@surefy/database';
import { Knex } from 'knex';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';

export type PlanFeature = 'Contact' | 'Campaign' | 'Chatbot' | 'TeamInvite' | 'Message' | 'Tag';

export function checkUsage(plan: any, feature: PlanFeature, count = 1, now = new Date()) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Usage count must be a non-negative integer');
  if (!plan || !plan.active) throw new HTTP403Error({ message: 'No active subscription plan found' });
  const start = new Date(plan.start_date).getTime();
  const end = new Date(plan.end_date).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || now.getTime() < start || now.getTime() >= end) {
    throw new HTTP403Error({ message: 'Subscription plan has not started or has expired' });
  }
  const limits = typeof plan.limits === 'string' ? JSON.parse(plan.limits) : plan.limits || {};
  const usage = typeof plan.usage === 'string' ? JSON.parse(plan.usage) : plan.usage || {};
  const key = feature;
  const limit = limits[key]?.limit;
  const used = Number(usage[key] ?? 0);
  // Missing limits retain legacy unlimited behavior; explicit zero denies creation.
  if (!Number.isSafeInteger(used) || used < 0 ||
      (limit !== undefined && limit !== null && (!Number.isSafeInteger(Number(limit)) || Number(limit) < 0))) {
    throw new HTTP403Error({ message: `Invalid ${feature} subscription limit or usage` });
  }
  if (limit !== undefined && limit !== null && used + count > Number(limit)) {
    throw new HTTP403Error({ message: `${feature} plan limit reached` });
  }
  return { key, used, usage };
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
  async run<T>(userId: string, feature: PlanFeature, create: (trx: Knex.Transaction, plan: any) => Promise<T>, count = 1): Promise<T> {
    return db.transaction(async trx => {
      // Same lock order as assignment: owner first, then current plan.
      await trx('users').where({ id: userId }).forUpdate().first();
      const plan = await trx('user_plans').where({ user_id: userId, active: true }).forUpdate().first();
      if (plan && feature === 'TeamInvite') {
        const usage = typeof plan.usage === 'string' ? JSON.parse(plan.usage) : plan.usage || {};
        plan.usage = { ...usage, TeamInvite: await countTeamSeats(trx, userId) };
      }
      const { key, used, usage } = checkUsage(plan, feature, count);
      const result = await create(trx, plan);
      await trx('user_plans').where({ id: plan.id }).update({
        usage: JSON.stringify({ ...usage, [key]: used + count }),
      });
      return result;
    });
  }
}
export default new PlanUsageService();
