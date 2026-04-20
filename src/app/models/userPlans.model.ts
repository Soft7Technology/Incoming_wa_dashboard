import { BaseModel } from '@surefy/models/base.model';

class userPlansModel extends BaseModel {
  constructor() {
    super('user_plans');
  }

  async getPlanByUserId(userId: string | number): Promise<any> {
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
    return this.query().where({ user_id: userId }).first();
  }
}

export default new userPlansModel();
