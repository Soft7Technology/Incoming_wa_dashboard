import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import HTTP500Error from '@surefy/exceptions/HTTP500Error';
import { subscriptionPlans } from '../interfaces/subscription.interface';
import subscriptionModel from '../models/subscription.model';
import { RazorpayOrderRequest } from '../interfaces/razorpay.interface';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import CompanyService from './company.service';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';

class subscriptionService {
  /**
   * Create Subscription Plans
   */
  private async razorpayOrderRequest(userData: RazorpayOrderRequest) {
    try {
      const { amount, currency = 'INR', receipt, notes = {} } = userData;

      const orderData = {
        amount: amount * 100, // ✅ convert to paise
        currency,
        receipt,
        notes,
      };

      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');

      const response = await axios.post(
        'https://api.razorpay.com/v1/orders',
        orderData, // ✅ correct payload
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          },
        },
      );

      console.log('✅ Razorpay Order Created:', response.data);

      return {
        success: true,
        order: response.data,
      };
    } catch (error: any) {
      console.error('❌ Razorpay Error');

      if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Data:', JSON.stringify(error.response.data, null, 2));

        return {
          success: false,
          error: error.response.data?.error?.description || 'Razorpay API error',
        };
      }

      console.error('Message:', error.message);

      return {
        success: false,
        error: error.message || 'Something went wrong',
      };
    }
  }
  async createSubscriptionPlan(userId: string, companyId: string, data: subscriptionPlans) {
    console.log('Creating subscription plan with data:', data);
    const newSubscriptionPlan = await subscriptionModel.create({ ...data, user_id: userId, company_id: companyId });
    return newSubscriptionPlan;
  }

  async getActiveSubscriptionPlan(companyId: string) {
    const subscription = await subscriptionModel.findCompanyActiveSubscriptions(companyId);
    return subscription;
  }

  async getSubscriptionPlans(companyId: string, active?: any) {
    const subscription = await subscriptionModel.findSubscriptionsPlans(companyId, active);
    return subscription;
  }

  async updateSubscriptionPlan(id: string, data: subscriptionPlans) {
    const updatedSubscriptionPlan = await subscriptionModel.update(id, {
      plan_name: data.plan_name,
      price: data.price,
      billing_cycle: data.billing_cycle,
      description: data.description,
      active: data.active,
      features: JSON.stringify(data.features), // important
    });
    return updatedSubscriptionPlan;
  }

  async subscribeUserPlan(planId: string, userId: string) {
    try {
      // 1. Get plan
      const planData = await subscriptionModel.findById(planId);

      if (!planData) {
        throw new HTTP400Error({ message: 'Subscription Plan not found' });
      }

      // 2. Prepare Razorpay order
      const orderData: RazorpayOrderRequest = {
        amount: planData.price,
        currency: 'INR',
        receipt: `receipt_${Date.now()}_${userId}`, // ✅ fixed
        notes: {
          userId: userId,
          planId: planData.id,
          planName: planData.plan_name, // ✅ better field
        },
      };

      // 3. Create Razorpay order (IMPORTANT: await)
      const razorPayOrder = await this.razorpayOrderRequest(orderData);

      if (!razorPayOrder.success) {
        throw new HTTP400Error({
          message: razorPayOrder.error || 'Failed to create payment order',
        });
      }

      console.log('✅ RazorPay response', razorPayOrder.order);

      // 4. Store subscription (pending state)
      const subscribePlan = await CompanyService.createUserPlan(
        userId,
        planData,
        razorPayOrder.order, // ✅ pass actual order
      );

      return {
        success: true,
        data: subscribePlan,
        razorpayOrder: razorPayOrder.order, // send to frontend
      };
    } catch (error: any) {
      console.error('🔥 Subscribe Plan Error:', error.message);

      throw new HTTP400Error({
        message: error.message || 'Failed to subscribe plan',
      });
    }
  }

  async deleteSubscriptionPlan(id: string) {
    const subcription = await subscriptionModel.findById(id);
    if (!subcription) {
      throw new HTTP500Error({ message: 'Subscription Plan not found' });
    }
    await subscriptionModel.delete(id);
    return;
  }

  async getSubscriptionPlanById(id: string) {
    const subscriptionPlan = await subscriptionModel.findById(id);
    if (!subscriptionPlan) {
      throw new HTTP500Error({ message: 'Subscription Plan not found' });
    }
    return subscriptionPlan;
  }

  async getDeafultSubscritionPlan(userId: string) {
    const subscriptionPlans = await subscriptionModel.findDefaultPlan();
    return subscriptionPlans;
  }
}

export default new subscriptionService();
