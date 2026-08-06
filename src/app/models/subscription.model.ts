import { BaseModel } from '@surefy/models/base.model';
import { subscriptionPlans } from '../interfaces/subscription.interface';
import subscriptionModel from './subscription.model';

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

  async createFreePlan(userId: string, companyId: string) {
    let data: subscriptionPlans = {} as subscriptionPlans;
    data.plan_name = 'Free Trial';
    data.price = 0;
    data.billing_cycle = 'Free';
    data.active = false;
    data.features = {
      Campaign: {
        limit_type: 'Campaign',
        limit_value: null,
      },
      Contact: {
        limit_type: 'Contact',
        limit_value: null,
      },
      Chatbot: {
        limit_type: 'Chatbot',
        limit_value: null,
      },
    };
    const newUserPlan = await subscriptionModel.create({
      ...data,
      user_id: userId,
      company_id: companyId,
    });
    return newUserPlan;
  }

  async findPlans(id: string, active: boolean): Promise<any> {
    return this.query().where({ id, active }).first();
  }
}

export default new SubscriptionModel();
