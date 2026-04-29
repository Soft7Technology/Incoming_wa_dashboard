import { BaseModel } from '@surefy/models/base.model';
import { subscriptionPlans } from '../interfaces/subscription.interface';
import subscriptionModel from './subscription.model';

class SubscriptionModel extends BaseModel {
  constructor() {
    super('subscription_plans');
  }

async findSubscriptionsPlans(userId:string,companyId?: string, active?: string, role?: string) {
  const isSuperAdmin = role === 'superadmin';

  const query = this.query();

  // apply company filter only for non-superadmin
  if (!isSuperAdmin) {
    if (!companyId) {
      throw new Error("company_id is required for non-superadmin");
    }
    query.where('company_id', companyId);
  }

  // optional active filter
  if (active !== undefined) {
    query.andWhere('active', active);
  }

  return query;
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
    return this.query().where({ user_id: '6691cc2c-faa0-4151-92be-d220320958b0' });
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

  async findPlans(id: string,active: boolean): Promise<any> {
    return this.query().where({ id, active }).first();
  }
}


export default new SubscriptionModel();


