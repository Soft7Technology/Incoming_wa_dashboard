import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import HTTP500Error from '@surefy/exceptions/HTTP500Error';
import { subscriptionPlans } from '../interfaces/subscription.interface';
import subscriptionModel from '../models/subscription.model';
import { RazorpayOrderRequest } from '../interfaces/razorpay.interface';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import CompanyService from './company.service';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import userPlansModel from '../models/userPlans.model';
import userModel from '../models/user.model';

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
          timeout: 10000, // ✅ timeout for better error handling
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

  async getSubscriptionPlans(userId: string,companyId:string,active?: any) {
    const user = await userModel.findById(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }
    const subscription = await subscriptionModel.findSubscriptionsPlans(userId,companyId, active,user.role);
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
  

  async activateFreeTrial(userId: string,planId:string) {
    // Check if user already has an active subscription or trial
    const planData = await subscriptionModel.findFreeTrial(planId)

    const userActivate = await userPlansModel.getPlanByUserId(userId)
    if(userActivate){
      throw new HTTP400Error({ message: 'User already has an active Trial' });
    }

    if (!planData) {
      throw new HTTP400Error({ message: 'Free trial already activated' });
    }
    
    const subscribePlan = await CompanyService.activateUserPlan(
        userId,
        planData
    );
    return subscribePlan;

  }



  async subscribeUserPlan(userId: string,companyId:string,planId: string) {
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
        receipt: `rcpt_${Date.now()}`, // ✅ fixed
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
        companyId,
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

  async assignedPlanToUser(userId: string, planId: string) {
    
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

  async activateUserPlanAfterPayment(userId: string, razorpayOrderId: string, razorpaymentId: string, razorpaySignature: string) {
    // 🔍 Step 2: Find existing subscription
    const subscription = await subscriptionModel.findByOrderId(razorpayOrderId);
    if(!subscription){
      throw new HTTP400Error({ message: 'Subscription not found for this order' });
    }


    if(subscription.status === 'verified'){
      throw new HTTP400Error({ message: 'Subscription already activated' });
    }

    const updateSubscriptionPlan = await subscriptionModel.update(userId, { razorpayOrderId,razorpaymentId,razorpaySignature, status: 'verified', payment_method:"RAZORPAY" });
    return updateSubscriptionPlan;
  }

  async activeUserPlan(orderId:string, data: any) {
    const subscription = await subscriptionModel.findByOrderId(orderId);
    if (!subscription) {
      throw new HTTP400Error({ message: 'Subscription not found for this order' });
    }

    const updateSubscriptionPlan = await subscriptionModel.update(subscription.id, {...data, active: true });
    return updateSubscriptionPlan;
  }

}

export default new subscriptionService();
