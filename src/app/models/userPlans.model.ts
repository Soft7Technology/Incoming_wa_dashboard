import { BaseModel } from '@surefy/models/base.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class userPlansModel extends BaseModel {
  constructor() {
    super('user_plans');
  }

  async getPlanByUserId(userId: string | number): Promise<any> {
    return this.query().where({ user_id: userId, active:true }).first();
  }

  async findPlanByUserId(userId: any): Promise<any> {
    return this.query().where({ user_id: userId }).first();
  }

  async incrementUsage(userId: string, feature: 'Contact' | 'Campaign' | 'Chatbot', count = 1) {
    console.log('Feature', feature, userId, count);
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

  async findUserSubscriptionPlan(planId: string) {
    return this.query().where({ id: planId }).first();
  }

  async getUserPlan(userId: string) {
    const userPlan = await this.query().where({ user_id: userId, active: true }).first();

    if (!userPlan) return null; // ✅ no error here

    const durationInDays = Math.ceil(
      (new Date(userPlan.end_date).getTime() - new Date(userPlan.start_date).getTime()) / (1000 * 60 * 60 * 24),
    );

    await this.update(userPlan.id, { duration_days: durationInDays });

    return await this.query().where({ user_id: userId, active: true }).first();
  }

  async getAllUserPlan(userId:string){
    return await this.query().where({user_id:userId})
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

  async findCompanyActiveSubscriptions(userId: string, companyId?: string, role?: string, filters?: any) {
    const isSuperAdmin = role === 'superadmin';

    if (!isSuperAdmin && !companyId) {
      throw new Error('company_id is required for non-superadmin');
    }

    const page = parseInt(filters?.page) || 1;
    const limit = parseInt(filters?.limit) || 10;
    const offset = (page - 1) * limit;

    const applyCompanyFilter = (query: any, column = 'company_id') => {
      if (!isSuperAdmin) {
        query.where(column, companyId);
      }

      return query;
    };

    // ✅ STATS QUERY
    const stats = await this.db('user_plans as up')
      .select(
        applyCompanyFilter(this.db('user_plans').count('*')).as('total_subscriptions'),

        applyCompanyFilter(this.db('user_plans').count('*').andWhere('active', true)).as('active_subscriptions'),

        applyCompanyFilter(this.db('user_plans').count('*').andWhere('active', false)).as('inactive_subscriptions'),

        applyCompanyFilter(this.db('user_plans').count('*').andWhere('end_date', '<', this.db.fn.now())).as(
          'expired_subscriptions',
        ),

        applyCompanyFilter(this.db('user_plans').sum('price as total_revenue').andWhere('active', true)).as(
          'total_revenue',
        ),

        applyCompanyFilter(this.db('user_plans').countDistinct('user_id')).as('total_users_with_plans'),

        applyCompanyFilter(this.db('user_plans').max('created_at as latest_subscription_date')).as(
          'latest_subscription_date',
        ),
      )
      .first();

    // ✅ BASE QUERY FOR SUBSCRIPTIONS
    const subscriptionsQuery = this.db('user_plans as up')
      .leftJoin('users as u', 'u.id', 'up.user_id')
      .modify((q: any) => {
        if (!isSuperAdmin) {
          q.where('up.company_id', companyId);
        }
      });

    // ✅ TOTAL COUNT FOR PAGINATION
    const totalResult = await subscriptionsQuery.clone().count('up.id as total').first();

    const total = Number(totalResult?.total || 0);

    // ✅ PAGINATED SUBSCRIPTIONS
    const subscriptions = await subscriptionsQuery
      .clone()
      .select(
        'up.id',
        'up.user_id',
        'up.plan_name',
        'up.price',
        'up.billing_cycle',
        'up.active',
        'up.status',
        'up.start_date',
        'up.end_date',
        'u.name as user_name',
        'u.email as user_email',
        'u.role as user_role',
      )
      .orderBy('up.created_at', 'desc')
      .offset(offset)
      .limit(limit);

    return {
      stats: {
        total_revenue: Number(stats?.total_revenue || 0),
        total_subscriptions: Number(stats?.total_subscriptions || 0),
        active_subscriptions: Number(stats?.active_subscriptions || 0),
        inactive_subscriptions: Number(stats?.inactive_subscriptions || 0),
        expired_subscriptions: Number(stats?.expired_subscriptions || 0),
        total_users_with_plans: Number(stats?.total_users_with_plans || 0),
        latest_subscription_date: stats?.latest_subscription_date || null,
      },

      subscriptions,

      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findPlanBySubscriptionId(subscription_id:any){
    return this.query().where({ subscription_id: subscription_id,active:true }).first();
  }
}

export default new userPlansModel();
