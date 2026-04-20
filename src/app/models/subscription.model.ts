import { BaseModel } from '@surefy/models/base.model';

class SubscriptionModel extends BaseModel {
  constructor() {
    super('subscription_plans');
  }

  async findSubscriptionsPlans(companyId:string, active?: string){
    const query = this.query().where({company_id: companyId});
    if (active) {
      query.andWhere({active});
    }
    return query;
  }

  async findCompanyActiveSubscriptions(companyId:string){
    return this.query().where({company_id:companyId,active:'true'})
  }

  async getUserPlan(userId: string) { 
    return this.query().where({user_id: userId}).first();
  }
}


export default new SubscriptionModel();


