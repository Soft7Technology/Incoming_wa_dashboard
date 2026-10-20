import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import { CatalogActor } from './planCatalog.service';
import { markActivityRecorded } from '../utils/activityContext';

const DAY_MS = 86400000;
const conflict = (message: string, code: string, extra = {}) => {
  throw new CustomError(message, HttpStatusCode.CONFLICT, true, { code, ...extra });
};

class PlanExtensionService {
  async extend(actor: CatalogActor, planId: string, body: unknown) {
    if (!actor.userId || !['admin', 'company', 'superadmin'].includes(actor.userRole || '') ||
        actor.userRole !== 'superadmin' && !actor.companyId) {
      throw new HTTP403Error({ message: 'A company administrator is required to extend subscriptions' });
    }
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(planId))
      throw new HTTP400Error({ message: 'userPlanId must be a user_plans UUID, not a subscription catalog ID' });
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['days', 'expected_end_date', 'reason'].includes(key))) {
      throw new HTTP400Error({ message: 'Only days, expected_end_date and optional reason are accepted' });
    }
    const { days, expected_end_date, reason } = body as Record<string, unknown>;
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > 3650)
      throw new HTTP400Error({ message: 'days must be a whole number between 1 and 3650' });
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
      const target = await lookup.first('user_id', 'company_id');
      if (!target) throw new HTTP404Error({ message: 'User plan not found in your company' });
      // Match assignment, quota consumption and purchases: owner first, then plan.
      const owner = await trx('users').where({ id: target.user_id, company_id: target.company_id })
        .whereNull('deleted_at').forUpdate().first('id', 'assigned_plan', 'role');
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
      const other = await trx('user_plans').where({ user_id: owner.id, active: true }).whereNot({ id: plan.id }).first('id');
      if (other) conflict('This user has multiple active plans. Reconcile their assignments before extending.', 'MULTIPLE_ACTIVE_PLANS');
      const base = Math.max(oldEnd, now.getTime());
      const endDate = new Date(base + days * DAY_MS);
      const durationDays = Math.ceil((endDate.getTime() - start) / DAY_MS);
      if (!Number.isFinite(endDate.getTime()) || !Number.isSafeInteger(durationDays) || durationDays > 2147483647)
        throw new HTTP400Error({ message: 'The resulting subscription period is too large' });
      await trx('user_plans').where({ id: plan.id }).update({
        end_date: endDate, duration_days: durationDays,
      });
      // Packs remain valid for this assigned plan's extended lifetime. Financial terms stay intact.
      await trx('user_plan_addons').where({ user_plan_id: plan.id, user_id: owner.id, company_id: plan.company_id })
        .update({ expires_at: endDate });
      const data = { id: plan.id, user_id: owner.id, plan_name: plan.plan_name, billing_cycle: plan.billing_cycle,
        days_added: days, previous_end_date: new Date(oldEnd).toISOString(), extension_starts_at: new Date(base).toISOString(),
        start_date: new Date(start).toISOString(), end_date: endDate.toISOString(), duration_days: durationDays,
        active: plan.active, status: plan.status };
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
