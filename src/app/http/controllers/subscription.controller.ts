import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import MessageService from '@surefy/console/services/message.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import subscriptionService from "../../services/subscription.service"
import crypto from 'crypto';
import activityLogsModel from '../../models/activityLogs.model';


class SubscriptionController {
  /**
   * Create Subscription Plans
   */
  createSubscription = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { plan_name, price, billing_cycle, description, active, features } = req.body;

    const newSubscription = await subscriptionService.createSubscriptionPlan(req.userId!, req.companyId!, {
      plan_name,
      price,
      billing_cycle,
      description,
      active,
      features,
    });

    await activityLogsModel.create({
      user_id: req.userId!,
      company_id: req.companyId!,

      action: 'CREATE',
      entity_type: 'SUBSCRIPTION',
      entity_id: newSubscription?.id,
      read: false,

      description: `Created subscription plan "${newSubscription?.plan_name}"`,

      new_data: {
        id: newSubscription?.id,
        plan_name: newSubscription?.plan_name,
        price: newSubscription?.price,
        billing_cycle: newSubscription?.billing_cycle,
        active: newSubscription?.active
      },

      ip_address:
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '',

      user_agent: req.headers['user-agent'] || '',

      request_method: req.method,
      api_endpoint: req.originalUrl,

      status: 'SUCCESS'
    });

    return successResponse(req, res, 'New Subscription created successfully', newSubscription, HttpStatusCode.CREATED);
  });

  getDeafultSubscritionPlan = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const effectiveUserId = req.ownerId ?? req.userId!;
    const subscriptionPlans = await subscriptionService.getDeafultSubscritionPlan(effectiveUserId);
    return successResponse(
      req,
      res,
      'New Subscription created successfully',
      subscriptionPlans,
      HttpStatusCode.CREATED,
    );
  });

  getSubscription = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const effectiveUserId = req.ownerId ?? req.userId!;
    const filters = {
      page: req.query.page,
      limit: req.query.limit,
    };
    const { active } = req.query;
    console.log('Active:', active);
    const subscription = await subscriptionService.getSubscriptionPlans(effectiveUserId, req.companyId!, active, filters);
    return successResponse(req, res, 'Subscription retrieved successfully', subscription, HttpStatusCode.OK);
  });

  getActiveSubscriptionPlans = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const subscription = await subscriptionService.getActiveSubscriptionPlan(req.companyId!);
    return successResponse(req, res, 'Active Subscription retrieved successfully', subscription, HttpStatusCode.OK);
  });

  updateSubscriptionPlan = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { plan_name, price, billing_cycle, description, active, features } = req.body;

    const updatedSubscription = await subscriptionService.updateSubscriptionPlan(id, {
      plan_name,
      price,
      billing_cycle,
      description,
      active,
      features,
    });

    const { data }: any = updatedSubscription;

    await activityLogsModel.create({
      company_id: data?.companyId,
      user_id: data?.userId,

      action: 'UPDATE',
      entity_type: 'SUBSCRIPTION',
      entity_id: id,
      read: false,

      description: `Updated subscription plan "${data?.plan_name}"`,

      new_data: {
        plan_name: data?.plan_name,
        price: data?.price,
        billing_cycle: data?.billing_cycle,
        active: data?.active,
        features: data?.features
      },

      ip_address:
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '',

      user_agent: req.headers['user-agent'] || '',

      request_method: req.method,
      api_endpoint: req.originalUrl,

      status: 'SUCCESS'
    });

    return successResponse(
      req,
      res,
      'Subscription Plan updated successfully',
      updatedSubscription,
      HttpStatusCode.OK
    );
  });

  subscribePlan = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { planId } = req.params;

    const subscribedUserPlan = await subscriptionService.subscribeUserPlan(
      req.userId!,
      req.companyId!,
      planId
    );

    const { data }: any = subscribedUserPlan

    await activityLogsModel.create({
      user_id: req.userId,
      company_id: req.companyId,

      action: 'SUBSCRIBE',
      entity_type: 'SUBSCRIPTION',
      entity_id: planId,
      read: false,

      description: `Activated subscription plan "${data?.plan_name}"`,

      new_data: {
        plan_id: planId,
        plan_name: data?.plan_name,
        status: data?.status,
        active: true,
      },

      ip_address:
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '',

      user_agent: req.headers['user-agent'] || '',
      request_method: req.method,
      api_endpoint: req.originalUrl,

      status: 'SUCCESS',
    });

    return successResponse(
      req,
      res,
      'User Plan get Activated',
      subscribedUserPlan
    );
  });

  //     const generatedSignature = crypto
  //   .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
  //   .update(`${razorpayOrderId}|${razorpayPaymentId}`)
  //   .digest("hex");

  // if (generatedSignature !== razorpaySignature) {
  //   return res.status(400).json({
  //     success: false,
  //     message: "Invalid payment signature",
  //   });
  // }

  activateUserPlanAfterPayment = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { razorpayOrderId, razorpaymentId, razorpaySignature } = req.body;
    console.log('Payment verification data:', req.body); // Debug log
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${razorpayOrderId}|${razorpaymentId}`)
      .digest('hex');

    if (generatedSignature !== razorpaySignature) {
      console.log('Generated Signature:', generatedSignature); // Debug log
      console.log('Received Signature:', razorpaySignature);
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature',
      });
    }

    const updateUserSubscriptionPlan = await subscriptionService.activateUserPlanAfterPayment(
      req.userId!,
      razorpayOrderId,
      razorpaymentId,
      razorpaySignature,
    );
    return successResponse(req, res, 'User Plan Activated after payment', updateUserSubscriptionPlan);
  });


  handleRazorWebhook = tryCatchAsync(async (req: Request, res: Response) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET!;
    const signature = req.headers['x-razorpay-signature'] as string;
    const body = JSON.stringify(req.body);
    const hash = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
    if (hash !== signature) {
      console.log('Invalid signature. Hash:', hash, 'Signature:', signature);
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const payload = JSON.parse(body);
    console.log('Razorpay Webhook Payload:', payload);

    if (payload.event === 'payment.captured' || payload.event === 'order.paid') {
      const payment = payload.payload.payment?.entity;
      if (payment) {
        const orderId = payment.order_id;
        const razorpayPaymentId = payment.id;
        const razorpaySignature = signature;
        const method = payment.method;
        const fee = payment.fee ? payment.fee / 100 : 0;
        const tax = payment.tax ? payment.tax / 100 : 0;
        const rrn = payment.acquirer_data?.rrn || payment.acquirer_data?.bank_transaction_id;

        const updateUserPlan = await subscriptionService.activeUserPlan(orderId, { razorpayPaymentId, razorpaySignature, method, fee, tax, rrn });
        console.log('User plan updated from webhook:', updateUserPlan);

        if (updateUserPlan.status === 'verified' || updateUserPlan.status === 'completed' && updateUserPlan.active === true) {
          console.log(`Order ${orderId} already processed by Verification API`);
          return res.status(200).json({ success: true, message: 'Webhook processed successfully' });
        }
      }
    }

  })

  //     try {
  //     const body = await request.text();
  //     const signature = request.headers.get("x-razorpay-signature")!;

  //     // Verify signature
  //     const hash = crypto
  //       .createHmac("sha256", RAZORPAY_KEY_SECRET)
  //       .update(body)
  //       .digest("hex");

  //     if (hash !== signature) {
  //       return NextResponse.json(
  //         { error: "Invalid signature" },
  //         { status: 400 }
  //       );
  //     }

  //     const payload = JSON.parse(body);

  //     if(payload.event === "payment.captured" || payload.event === "order.paid"){
  //       const payment = payload.payload.payment?.entity;
  //       if (!payment) return NextResponse.json({ received: true }, { status: 200 });
  //       const orderId = payment.order_id;

  //       const method = payment.method;
  //       const fee = payment.fee ? payment.fee/100 : 0;
  //       const tax = payment.tax ? payment.tax/100 : 0;
  //       const rrn = payment.acquirer_data?.rrn || payment.acquirer_data?.bank_transaction_id;

  //       await prisma.$transaction(async (tx)=>{
  //         const subscription = await tx.subscription.findUnique({
  //           where:{
  //             razorpayOrderId: orderId
  //           },
  //           include: {
  //             user: true
  //           }
  //         })

  //         if(!subscription){
  //           throw new Error("Subscription not found");
  //         }

  //         if(subscription.status === "completed"){
  //           console.log(`Order ${orderId} already processed by Verification API`);
  //           return;
  //         }

  //         const plan = await prisma.subscription_plans.findFirst({
  //           where: { name: subscription.planType },
  //         });

  //         if (!plan) {
  //           throw new Error("Subscription plan not found");
  //         }

  //         const planDays = plan.billingCycle === "YEARLY" ? 365 : 30;

  //         const user = subscription.user;

  //         let finalEndDate = new Date();
  //         finalEndDate.setDate(finalEndDate.getDate() + planDays);

  //         if(user?.isPremium && user?.subscriptionEnd && new Date(user.subscriptionEnd) > new Date()){
  //         const oldPlan = await prisma.subscription_plans.findFirst({
  //           where: {
  //             name: {
  //               equals: user.subscriptionPlan!,
  //               mode: "insensitive",
  //             },
  //           },
  //         });

  //         if(oldPlan){
  //           const oldDays = oldPlan.billingCycle === "YEARLY" ? 365 : 30;
  //           const today = new Date();
  //           const end = new Date(user.subscriptionEnd);

  //           const remainingDays = (end.getTime() - today.getTime()) / (24 * 60 * 60 * 1000);
  //           const dailyRateOld = oldPlan.price / oldDays;
  //           const remainingValue = dailyRateOld * remainingDays;

  //           const dailyRateNew = plan.price / planDays;
  //           const creditDays = Math.floor(remainingValue/dailyRateNew);

  //           finalEndDate.setDate(finalEndDate.getDate() + creditDays);
  //         }
  //       }

  //       await tx.subscription.update({
  //         where: {
  //           id: subscription.id
  //         },
  //         data: {
  //           razorpayPaymentId: payment.id,
  //           razorpaySignature: signature,
  //           status: "completed",
  //           paymentMethod: method,
  //           vpa: payment.vpa || null,
  //           bank: payment.bank || null,
  //           wallet: payment.wallet || null,
  //           last4: payment.card?.last4 || null,
  //           rrn: rrn || null,
  //           razorpayFee: fee,
  //           razorpayTax: tax,
  //           endDate: finalEndDate,
  //           startDate: new Date()
  //         }
  //       });

  //       const startDate = new Date();

  //       await tx.user.update({
  //         where: {
  //           id: subscription.userId,
  //         },
  //         data: {
  //           isPremium: true,
  //           plan: plan.name,
  //           subscriptionPlan: plan.name,
  //           subscriptionStart: startDate,
  //           subscriptionEnd: finalEndDate,
  //           razorpayCustomerId: payment.customer_id,
  //         },
  //       });

  //       // Unify with admin/verify flow: create UserSubscription
  //       await tx.userSubscription.deleteMany({ where: { userId: subscription.userId } });
  //       await tx.userSubscription.create({
  //         data: {
  //           userId: subscription.userId,
  //           companyId: plan.companyId,
  //           planId: plan.id,
  //           startDate,
  //           endDate: finalEndDate,
  //           status: "ACTIVE",
  //           autoRenew: true,
  //           updatedAt: startDate,
  //         },
  //       });
  //       });
  //     }

  //     return NextResponse.json({ received: true }, { status: 200 });
  //   } catch (error) {
  //     console.error("Webhook error:", error);
  //     return NextResponse.json(
  //       { error: "Webhook processing failed" },
  //       { status: 500 }
  //     );
  //   }


  deleteSubscriptionPlan = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const deleteSubscription = await subscriptionService.deleteSubscriptionPlan(id);
    return successResponse(req, res, 'Subscription Plan deleted successfully', deleteSubscription, HttpStatusCode.OK);
  });

  getSubscriptionPlanById = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const subscriptionPlan = await subscriptionService.getSubscriptionPlanById(id);
    return successResponse(req, res, 'Subscription Plan retrieved successfully', subscriptionPlan, HttpStatusCode.OK);
  });

  activateFreeTrial = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { planId } = req.params;
    const activatedTrial = await subscriptionService.activateFreeTrial(req.userId!, planId);
    return successResponse(req, res, 'Free trial activated successfully', activatedTrial, HttpStatusCode.OK);
  })

  cancelUserSubscriptionPlan = tryCatchAsync(
    async (req: AuthRequest, res: Response) => {
      const { planId } = req.params;

      const cancelSubscriptionPlan =
        await subscriptionService.cancelSubscriptionPlan(planId);

      await activityLogsModel.create({
        user_id: req.userId,
        company_id: req.companyId,

        action: 'CANCEL',
        entity_type: 'SUBSCRIPTION',
        entity_id: planId,
        read: false,

        description: `Cancelled subscription plan "${cancelSubscriptionPlan?.plan_name}"`,

        new_data: {
          plan_id: planId,
          plan_name: cancelSubscriptionPlan?.plan_name,
          status: cancelSubscriptionPlan?.status,
          active: false,
        },

        ip_address:
          (req.headers['x-forwarded-for'] as string) ||
          req.socket.remoteAddress ||
          '',

        user_agent: req.headers['user-agent'] || '',
        request_method: req.method,
        api_endpoint: req.originalUrl,

        status: 'SUCCESS',
      });

      return successResponse(
        req,
        res,
        'Cancel Subscription Plan',
        cancelSubscriptionPlan,
        HttpStatusCode.OK
      );
    }
  );
}

export default new SubscriptionController();