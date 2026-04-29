import { BaseModel } from '@surefy/models/base.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class userPlansModel extends BaseModel {
  constructor() {
    super('user_plans');
  }

  async getPlanByUserId(userId: string | number): Promise<any> {
    return this.query().where({ user_id: userId, status:"COMPLETED" }).first();
  }

  async findPlanByUserId(userId: string | number): Promise<any> {
    return this.query().where({ user_id: userId }).first();
  }

  async incrementUsage(userId: string, feature: 'Contact' | 'Campaign' | 'Chatbot', count = 1) {
    console.log("Feature",feature,userId,count)
    return this.query()
      .where('user_id', userId)
      .update({
        usage: this.query().client.raw(`
        jsonb_set(
          usage,
          '{${feature}}',
          to_jsonb(COALESCE((usage->>'${feature}')::int, 0) + ${count})
        )
      `),
      });
  }

  async resetUsage(userId: string | number, type: 'contact' | 'campaign' | 'chatbot') {
    const column = `${type}s_used`;
    await this.query().where({ user_id: userId }).update(column, 0);
  }

  // async updatePlanLimits(userId: string | number, limits: {contact_limit?: number, campaign_limit?: number, chatbot_limit?: number}) {

  async updatePlan(userId: string | number, data: any) {
    return this.query().where({ user_id: userId }).update(data).returning('*');
  }

async getUserPlan(userId: string) {
  const userPlan = await this.query()
    .where({ user_id: userId, active: true })
    .first();

  if (!userPlan) return null; // ✅ no error here

  const durationInDays = Math.ceil(
    (new Date(userPlan.end_date).getTime() - new Date(userPlan.start_date).getTime()) 
    / (1000 * 60 * 60 * 24)
  );

  await this.update(userPlan.id, { duration_days: durationInDays });

  return await this.query().where({ user_id: userId, active: true }).first();
}

//   async findCompanyActiveSubscriptions(companyId: string) {
//   return this.db('user_plans as up')
//     .select(
//       'up.*',
//       'u.name as user_name',
//       'u.role as user_role',
//       'u.email as user_email'
//     )
//     .leftJoin('users as u', 'u.id', 'up.user_id')
//     .where({
//       'up.company_id': companyId,
//       'up.active': true
//     })
//     .orderBy('up.created_at', 'desc');
// }

async findCompanyActiveSubscriptions(userId: string, companyId?: string, role?: string) {
  const isSuperAdmin = role === 'superadmin';

  if (!isSuperAdmin && !companyId) {
    throw new Error("company_id is required for non-superadmin");
  }

  const applyCompanyFilter = (query: any, column = 'company_id') => {
    if (!isSuperAdmin) {
      query.where(column, companyId);
    }
    return query;
  };

  const result = await this.db('user_plans as up')
    .select(

      // 🔢 STATS
      applyCompanyFilter(
        this.db('user_plans').count('*')
      ).as('total_subscriptions'),

      applyCompanyFilter(
        this.db('user_plans').count('*').andWhere('active', true)
      ).as('active_subscriptions'),

      applyCompanyFilter(
        this.db('user_plans').count('*').andWhere('active', false)
      ).as('inactive_subscriptions'),

      applyCompanyFilter(
        this.db('user_plans').count('*').andWhere('end_date', '<', this.db.fn.now())
      ).as('expired_subscriptions'),

      applyCompanyFilter(
        this.db('user_plans').sum('price as total_revenue').andWhere('active', true)
      ).as('total_revenue'),

      applyCompanyFilter(
        this.db('user_plans').countDistinct('user_id')
      ).as('total_users_with_plans'),

      applyCompanyFilter(
        this.db('user_plans').max('created_at as latest_subscription_date')
      ).as('latest_subscription_date'),

      // 📦 DETAILS
      this.db.raw(`
        COALESCE(
          json_agg(
            jsonb_build_object(
              'id', up.id,
              'user_id', up.user_id,
              'plan_name', up.plan_name,
              'price', up.price,
              'billing_cycle', up.billing_cycle,
              'active', up.active,
              'status', up.status,
              'start_date', up.start_date,
              'end_date', up.end_date,
              'user_name', u.name,
              'user_email', u.email,
              'user_role', u.role
            )
          ) FILTER (WHERE up.id IS NOT NULL),
          '[]'
        ) as subscriptions
      `)
    )

    .leftJoin('users as u', 'u.id', 'up.user_id')

    // ✅ apply only if NOT superadmin
    .modify((q: any) => {
      if (!isSuperAdmin) {
        q.where('up.company_id', companyId);
      }
    })

    .first();

  return {
    ...result,
    total_revenue: Number(result.total_revenue || 0),
    total_subscriptions: Number(result.total_subscriptions || 0),
    active_subscriptions: Number(result.active_subscriptions || 0),
    inactive_subscriptions: Number(result.inactive_subscriptions || 0),
    expired_subscriptions: Number(result.expired_subscriptions || 0),
    total_users_with_plans: Number(result.total_users_with_plans || 0),
  };
}


}

export default new userPlansModel();
