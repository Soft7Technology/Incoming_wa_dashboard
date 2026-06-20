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
import companyModel from '../models/company.model';
import creditTransactionModel from '../models/creditTransaction.model';

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


  
      // // Create transaction
      // const transaction = await CreditTransactionModel.create({
      //   company_id: data.company_id,
      //   company_name:data.company_name,
      //   type: 'credit',
      //   amount: data.amount,
      //   balance_before: balanceBefore,
      //   balance_after: balanceAfter,
      //   description: `${data.amount} Credits added to ${data.company_name}`,
      //   created_by: data.created_by,
      //   reference_type: 'manual',
      // });
  
      // // Update company balance
      // await CompanyModel.update(data.company_id, {
      //   credit_balance: balanceAfter,
      // });

            // const balanceBefore = parseFloat(company.credit_balance || '0');
      // const balanceAfter = balanceBefore + data.amount;

  async createSubscriptionPlan(userId: string, companyId: string | undefined, userRole: string, data: subscriptionPlans) {
    console.log('Creating subscription plan with data:', data, 'role:', userRole);

    // SuperAdmin creates global platform plans — no company or credit check needed
    if (userRole === 'superadmin') {
      const newSubscriptionPlan = await subscriptionModel.create({ ...data, user_id: userId });
      return newSubscriptionPlan;
    }

    // For regular company users: check company exists and has enough credit balance
    if (!companyId) {
      throw new HTTP400Error({ message: "Company Not found" })
    }
    const companyDetails = await companyModel.findById(companyId)
    if (!companyDetails) {
      throw new HTTP400Error({ message: "Company Not found" })
    }

    if (companyDetails.credit_balance >= data.price) {
      const balanceBefore = parseFloat(companyDetails.credit_balance)
      const balanceAfter = balanceBefore - data.price

      await creditTransactionModel.create({
        company_id: companyId,
        company_name: companyDetails.company_name,
        type: 'debit',
        amount: balanceAfter,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        description: `${data.price} Debited from ${companyDetails.company_name} wallet`,
        created_by: userId,
        reference_type: 'manual',
      });

      await companyModel.update(companyDetails.id, {
        credit_balance: balanceAfter
      });

      const newSubscriptionPlan = await subscriptionModel.create({ ...data, user_id: userId, company_id: companyId });
      return newSubscriptionPlan;
    } else {
      throw new HTTP400Error({ message: "Your Company does not have enough credit balance to create a new Subscription Plan" })
    }
  }

  async getActiveSubscriptionPlan(companyId: string) {
    const subscription = await subscriptionModel.findCompanyActiveSubscriptions(companyId);
    return subscription;
  }

  async getSubscriptionPlans(userId: string, companyId: string, active?: any, filters?: any) {
    const user = await userModel.findById(userId);

    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }

    return await subscriptionModel.findSubscriptionsPlans(userId, companyId, active, user.role, filters);
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

  async activateFreeTrial(userId: string, planId: string) {
    // Check if user already has an active subscription or trial
    const planData = await subscriptionModel.findFreeTrial(planId);

    const userActivate = await userPlansModel.getPlanByUserId(userId);
    if (userActivate) {
      throw new HTTP400Error({ message: 'User already has an active Trial' });
    }

    if (!planData) {
      throw new HTTP400Error({ message: 'Free trial already activated' });
    }

    const subscribePlan = await CompanyService.activateUserPlan(userId, planData);
    return subscribePlan;
  }

  async subscribeUserPlan(userId: string, companyId: string, planId: string) {
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

  async assignedPlanToUser(userId: string, planId: string) {}

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

  async activateUserPlanAfterPayment(
    userId: string,
    razorpayOrderId: string,
    razorpaymentId: string,
    razorpaySignature: string,
  ) {
    // 🔍 Step 2: Find existing subscription
    const subscription = await subscriptionModel.findByOrderId(razorpayOrderId);
    if (!subscription) {
      throw new HTTP400Error({ message: 'Subscription not found for this order' });
    }

    if (subscription.status === 'verified') {
      throw new HTTP400Error({ message: 'Subscription already activated' });
    }

    const updateSubscriptionPlan = await subscriptionModel.update(userId, {
      razorpayOrderId,
      razorpaymentId,
      razorpaySignature,
      status: 'verified',
      payment_method: 'RAZORPAY',
    });
    return updateSubscriptionPlan;
  }

  async activeUserPlan(orderId: string, data: any) {
    const subscription = await subscriptionModel.findByOrderId(orderId);
    if (!subscription) {
      throw new HTTP400Error({ message: 'Subscription not found for this order' });
    }

    const updateSubscriptionPlan = await subscriptionModel.update(subscription.id, { ...data, active: true });
    return updateSubscriptionPlan;
  }

  async cancelSubscriptionPlan(planId: string) {
    const subscriptionPlan = await userPlansModel.findUserSubscriptionPlan(planId);
    if (!subscriptionPlan) {
      throw new HTTP400Error({ message: 'Subscription Plan not found for this order' });
    }
    const cancelSubscriptionPlan = await userPlansModel.update(planId, { active: false, status: 'CANCELLED' });
    return cancelSubscriptionPlan;
  }
}

export default new subscriptionService();
