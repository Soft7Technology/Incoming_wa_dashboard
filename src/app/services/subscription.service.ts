import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import HTTP500Error from '@surefy/exceptions/HTTP500Error';
import {subscriptionPlans } from '../interfaces/subscription.interface';
import subscriptionModel from '../models/subscription.model';

class subscriptionService {
  /**
   * Create Subscription Plans
   */
  async createSubscriptionPlan(userId: string, companyId: string, data: subscriptionPlans) {
    console.log("Creating subscription plan with data:", data);
    const newSubscriptionPlan = await subscriptionModel.create({ ...data, user_id: userId, company_id: companyId });
    return newSubscriptionPlan;
  }

  async getActiveSubscriptionPlan(companyId: string) {
    const subscription = await subscriptionModel.findCompanyActiveSubscriptions(companyId);
    return subscription;
  }

  async getSubscriptionPlans(companyId: string, active?: any) {
    const subscription = await subscriptionModel.findSubscriptionsPlans(companyId,active);
    return subscription;
  } 

  async updateSubscriptionPlan(id: string, data: subscriptionPlans) {
    const updatedSubscriptionPlan = await subscriptionModel.update(id, data);
    return updatedSubscriptionPlan;
  }

  async deleteSubscriptionPlan(id: string) {
    const subcription = await subscriptionModel.findById(id);
    if (!subcription) {
      throw new HTTP500Error({ message: 'Subscription Plan not found' });
    }
    await subscriptionModel.delete(id);
    return;
  }

  async getSubscriptionPlanById(id: string){
    const subscriptionPlan = await subscriptionModel.findById(id);
    if(!subscriptionPlan){
      throw new HTTP500Error({message: 'Subscription Plan not found'})
    }
    return subscriptionPlan;
  }
}

export default new subscriptionService();