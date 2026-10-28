import { Knex } from 'knex';
import { BaseModel } from '@surefy/models/base.model';
import { freeTrialFeatures, newTrialDays } from '../utils/freeTrialPolicy';
import { snapshotFeatures } from '../utils/planFeatures';
import { calculatePlanPeriod } from '../utils/subscriptionDuration';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class SubscriptionModel extends BaseModel {
  constructor() {
    super('subscription_plans');
  }

  async findSubscriptionsPlans(userId: string, companyId?: string, active?: string, role?: string, filters?: any) {
    const isSuperAdmin = role === 'superadmin';

    const page = parseInt(filters?.page) || 1;
    const limit = parseInt(filters?.limit) || 10;

    const offset = (page - 1) * limit;

    const baseQuery = this.query();

    // ✅ Apply company filter only for non-superadmin
    if (!isSuperAdmin) {
      if (!companyId) {
        throw new Error('company_id is required for non-superadmin');
      }

      baseQuery.where('company_id', companyId);
    }

    // ✅ Optional active filter
    if (active !== undefined) {
      baseQuery.andWhere('active', active);
    }

    // ✅ Total count
    const totalResult = await baseQuery.clone().count('* as total').first();

    const total = Number(totalResult?.total || 0);

    // ✅ Paginated data
    const data = await baseQuery.clone().offset(offset).limit(limit).orderBy('created_at', 'desc');

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findCompanyActiveSubscriptions(companyId: string) {
    return this.query()
      .select('user_plans.*', 'users.name as user_name', 'users.role as user_role')
      .rightJoin('users', 'user_plans.user_id', 'users.id') // ✅ match SQL
      .where({
        'user_plans.company_id': companyId,
        'user_plans.active': true,
      });
  }
  async getUserPlan(userId: string) {
    return this.query().where({ user_id: userId }).first();
  }

  async findDefaultPlan() {
    return this.query().where({ company_id: 'ae815512-cf4b-4e7e-8472-16d3c2d4bb18' });
  }

  async findByOrderId(razorpayOrderId: string) {
    return this.query().where({ razorpayOrderId }).first();
  }

  async findFreeTrial(planId: string) {
    return this.query().where({ id: planId, active: true }).first();
  }

  async createFreePlan(userId: string, companyId: string, trx?: Knex.Transaction, trialDays?: unknown) {
    const days = newTrialDays(trialDays);
    const create = async (transaction: Knex.Transaction) => {
      const user = await transaction('users').where({ id: userId, company_id: companyId }).whereNull('deleted_at').forUpdate().first();
      if (!user || !['admin', 'company'].includes(user.role)) throw new HTTP400Error({ message: 'A company administrator is required for the registration trial' });
      const prior = await transaction('user_plans').where({ user_id: userId, billing_cycle: 'Free' }).first();
      const active = await transaction('user_plans').where({ user_id: userId, active: true }).first();
      if (prior || active) throw new HTTP400Error({ message: 'User already has a subscription or has used a free trial' });
      const features = freeTrialFeatures();
      const definition = await this.create({
        plan_name: 'Free Trial', price: 0, billing_cycle: 'Free', trial_days: days,
        description: 'Free trial with fixed platform limits', active: true, features,
        user_id: userId, company_id: companyId,
      }, transaction);
      const now = new Date();
      const { endDate, durationDays } = calculatePlanPeriod({ billing_cycle: 'Free', trial_days: days }, now);
      const { limits, usage } = snapshotFeatures(features);
      const [plan] = await transaction('user_plans').insert({
        user_id: userId, company_id: companyId, subscription_id: definition.id,
        plan_name: definition.plan_name, price: 0, billing_cycle: 'Free',
        active: true, status: 'COMPLETED', start_date: now, end_date: endDate,
        duration_days: durationDays, limits: JSON.stringify(limits), usage: JSON.stringify(usage),
        entitlement_version: 2,
      }).returning('*');
      await transaction('users').where({ id: userId }).update({ assigned_plan: plan.id });
      await transaction('activity_logs').insert({
        user_id: userId, company_id: companyId, action: 'ACTIVATE', entity_type: 'SUBSCRIPTION',
        entity_id: plan.id, read: false, status: 'SUCCESS', description: `Activated ${days}-day registration trial`,
        new_data: JSON.stringify({ subscription_id: definition.id, user_plan_id: plan.id, trial_days: days, limits }),
      });
      return { ...definition, user_plan: plan };
    };
    return trx ? create(trx) : this.db.transaction(create);
  }

  async findPlans(id: string, active: boolean): Promise<any> {
    return this.query().where({ id, active }).first();
  }
}

export default new SubscriptionModel();
