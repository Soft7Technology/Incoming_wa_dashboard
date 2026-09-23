import { countTeamSeats } from './planUsage.service';
import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { calculatePlanPeriod } from '../utils/subscriptionDuration';

interface Actor { userId?: string; companyId?: string; userRole?: string }

class PlanAssignmentService {
  async updateUser(userId: string, data: any, actor?: Actor, trialOnly = false) {
    return db.transaction(async trx => {
      const planId = data.assigned_plan;
      const plan = planId
        ? await trx('subscription_plans').where({ id: planId, active: true }).forShare().first()
        : null;
      if (planId && !plan) throw new HTTP400Error({ message: 'Assigned subscription plan not found or not active' });
      if (trialOnly && (!plan || plan.billing_cycle !== 'Free')) {
        throw new HTTP400Error({ message: 'Active Free subscription plan not found' });
      }
      const fee = plan?.billing_cycle === 'Monthly' ? 100 : plan?.billing_cycle === 'Yearly' ? 1000 : 0;
      const recipient = fee > 0
        ? await trx('users').where({ role: 'superadmin' }).whereNull('deleted_at').orderBy('id').first()
        : null;
      // Stable row order prevents assignments to the fee recipient deadlocking.
      const users = await trx('users').whereIn('id', recipient ? [userId, recipient.id] : [userId]).orderBy('id').forUpdate();
      const user = users.find(row => row.id === userId);
      if (!user) throw new HTTP404Error({ message: 'User not found' });
      if (actor && actor.userRole !== 'superadmin' &&
          (!actor.companyId || actor.companyId !== user.company_id || !['admin', 'company'].includes(actor.userRole || ''))) {
        throw new HTTP403Error({ message: 'Not authorized to update this company user' });
      }
      const updates: any = {};
      for (const key of ['name', 'email', 'phone', 'permissions']) {
        if (data[key] !== undefined) updates[key] = typeof data[key] === 'object' && data[key] !== null
          ? JSON.stringify(data[key]) : data[key];
      }
      if (!plan) {
        if (Object.keys(updates).length === 0) return { user, plan: null };
        const [updated] = await trx('users').where({ id: userId }).update(updates).returning('*');
        await trx('activity_logs').insert({
          user_id: actor?.userId || userId, company_id: user.company_id,
          action: 'UPDATE', entity_type: 'USER', entity_id: userId, read: false,
          status: 'SUCCESS', description: `Updated user ${updated.name}`,
          new_data: JSON.stringify(updates),
        });
        return { user: updated, plan: null };
      }
      if (plan.company_id && plan.company_id !== user.company_id) {
        throw new HTTP400Error({ message: 'Subscription plan belongs to another company' });
      }
      const price = Number(plan.price);
      if (!Number.isFinite(price) || price < 0 || (plan.billing_cycle === 'Free' && price !== 0)) {
        throw new HTTP400Error({ message: 'Invalid subscription price; Free plans must have zero price' });
      }
      const activePlans = await trx('user_plans').where({ user_id: userId, active: true }).forUpdate();
      if (activePlans.length > 1) {
        throw new HTTP400Error({ message: 'User has multiple active plans; reconcile them before assigning a new plan' });
      }
      const existing = activePlans[0];
      const now = new Date();
      const unexpired = existing && new Date(existing.end_date).getTime() > now.getTime();
      if (unexpired && existing.subscription_id === plan.id) {
        throw new HTTP400Error({ message: 'User is already assigned to this subscription plan' });
      }
      if (trialOnly) {
        const trial = await trx('user_plans').where({ user_id: userId, billing_cycle: 'Free' }).first();
        if (trial || unexpired) throw new HTTP400Error({ message: 'User is not eligible for a free trial' });
      }
      if (unexpired && existing.billing_cycle !== 'Free' && plan.billing_cycle === 'Free') {
        throw new HTTP400Error({ message: 'Cancel the active paid plan before assigning a Free plan' });
      }
      const { endDate, durationDays, remainingDays } = calculatePlanPeriod(plan, now, existing);
      const features = typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features;
      if (!features || typeof features !== 'object' || Array.isArray(features)) {
        throw new HTTP400Error({ message: 'Invalid subscription features' });
      }
      const limits: any = {};
      const usage: any = {};
      for (const key of Object.keys(features)) {
        limits[key] = { limit: features[key]?.limit_value ?? null };
        usage[key] = 0;
      }
      usage.TeamInvite = await countTeamSeats(trx, userId);
      if (fee > 0) {
        const company = user.company_id
          ? await trx('companies').where({ id: user.company_id }).forUpdate().first() : null;
        if (!company) throw new HTTP400Error({ message: 'A company wallet is required to assign a paid plan' });
        const superAdmin = users.find(row => row.id === recipient?.id);
        if (!superAdmin) throw new HTTP400Error({ message: 'Super admin not found' });
        const before = Number(company.credit_balance || 0);
        const recipientBefore = Number(superAdmin.credit_balance || 0);
        if (!Number.isFinite(before) || !Number.isFinite(recipientBefore) || before < fee) {
          throw new HTTP400Error({ message: `Insufficient or invalid company wallet balance. Required ${fee}` });
        }
        await trx('companies').where({ id: company.id }).update({ credit_balance: trx.raw('credit_balance - ?', [fee]) });
        await trx('users').where({ id: superAdmin.id }).update({ credit_balance: trx.raw('COALESCE(credit_balance, 0) + ?', [fee]) });
        const createdBy = actor?.userId || userId;
        await trx('credit_transactions').insert([
          { company_id: company.id, user_id: userId, type: 'debit', amount: -fee,
            balance_before: before, balance_after: before - fee, created_by: createdBy,
            reference_type: 'subscription_commission', description: `Platform fee for ${plan.plan_name}` },
          { company_id: superAdmin.company_id, user_id: superAdmin.id, type: 'credit', amount: fee,
            balance_before: recipientBefore, balance_after: recipientBefore + fee, created_by: createdBy,
            reference_type: 'subscription_commission', description: `Platform fee from ${company.company_name || company.name}` },
        ]);
      }
      if (existing) {
        // Keep historical dates intact; active/status determine which plan is current.
        await trx('user_plans').where({ id: existing.id }).update({ active: false, status: unexpired ? 'CANCELLED' : 'EXPIRED' });
      }
      const [newPlan] = await trx('user_plans').insert({
        user_id: userId, company_id: user.company_id, subscription_id: plan.id,
        plan_name: plan.plan_name, price: plan.price, billing_cycle: plan.billing_cycle,
        status: 'COMPLETED', active: true, start_date: now, end_date: endDate,
        duration_days: durationDays, limits: JSON.stringify(limits), usage: JSON.stringify(usage),
      }).returning('*');
      const [updated] = await trx('users').where({ id: userId }).update({
        ...updates, status: 'active', assigned_plan: newPlan.id,
      }).returning('*');
      await trx('activity_logs').insert({
        user_id: actor?.userId || userId, company_id: user.company_id,
        action: existing ? 'UPGRADE' : 'ACTIVATE', entity_type: 'SUBSCRIPTION', entity_id: newPlan.id,
        read: false, status: 'SUCCESS', description: `Assigned ${plan.plan_name} to ${user.name}`,
        new_data: JSON.stringify({ assigned_plan: newPlan.id, subscription_id: plan.id,
          commission: fee, start_date: now, end_date: endDate, remaining_days_carried: remainingDays }),
      });
      return { user: { ...updated, plan_name: newPlan.plan_name, duration_days: newPlan.duration_days }, plan: newPlan };
    });
  }
}

export default new PlanAssignmentService();
