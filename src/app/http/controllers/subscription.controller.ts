import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import MessageService from '@surefy/console/services/message.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import subscriptionService from "../../services/subscription.service"
import CompanyService from '../../services/company.service';

    // planName:string;
    // price:string;
    // billingCycle: "Monthly" | "Yearly";
    // description:string;
    // active: boolean;
    // featureLabel:string;
    // limitType:string;
    // limitValue:string;

class SubscriptionController{
    /**
     * Create Subscription Plans
     */
    createSubscription = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const{plan_name,price,billing_cycle,description,active,features} = req.body
        
        const newSubscription = await subscriptionService.createSubscriptionPlan(req.userId!,req.companyId!,{plan_name,price,billing_cycle,description,active,features})
        return successResponse(req, res, 'New Subscription created successfully', newSubscription, HttpStatusCode.CREATED);
    })

    getDeafultSubscritionPlan = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const subscriptionPlans = await subscriptionService.getDeafultSubscritionPlan(req.userId!)
        return successResponse(req, res, 'New Subscription created successfully', subscriptionPlans, HttpStatusCode.CREATED);
    })

    getSubscription = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const{active} = req.query
        // if(active === 'true'){
        //     const subscription = await subscriptionService.getActiveSubscriptionPlan(req.companyId!)
        //     return successResponse(req, res, 'Active Subscription retrieved successfully', subscription, HttpStatusCode.OK);
        // }
        console.log("Active:", active);
        const subscription = await subscriptionService.getSubscriptionPlans(req.companyId!,active)
        return successResponse(req, res, 'Subscription retrieved successfully', subscription, HttpStatusCode.OK);
    })

    getActiveSubscriptionPlans = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const subscription = await subscriptionService.getActiveSubscriptionPlan(req.companyId!)
        return successResponse(req, res, 'Active Subscription retrieved successfully', subscription, HttpStatusCode.OK);
    })

    updateSubscriptionPlan = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const {id} = req.params
        const {plan_name,price,billing_cycle,description,active,features} = req.body
        console.log("Body",req.body)

        const updatedSubscription = await subscriptionService.updateSubscriptionPlan(id,{plan_name,price,billing_cycle,description,active,features})
        return successResponse(req, res, 'Subscription Plan updated successfully', updatedSubscription, HttpStatusCode.OK);
    })

    subscribePlan = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const {planId} = req.params
        const subscribedUserPlan = await subscriptionService.subscribeUserPlan(planId,req.userId!)
        console.log("UserPlan",subscribedUserPlan)
        return successResponse(req,res,"User Plan get Activated",subscribedUserPlan)
    })

    // subscribePlan = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    //     const {planId} = req.params
    //     const{razorpayOrderId,razorpaymentId,razorpaySignature} = req.body
    
    //     console.log("Subscribing to plan with query:", planId) // Debug log

    //             // Create Razorpay order
    // const orderData: RazorpayOrderRequest = {
    //   amount: amountInPaise,
    //   currency: "INR",
    //   receipt: `receipt_${Date.now()}_${user?.id}`,
    //   notes: {
    //     userId: user?.id?.toString(),
    //     planId: resolvedPlanId,
    //     planName: planType,
    //   },
    // };

    // const response = await fetch("https://api.razorpay.com/v1/orders", {
    //   method: "POST",
    //   headers: {
    //     "Content-Type": "application/json",
    //     Authorization: `Basic ${Buffer.from(
    //       `${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`
    //     ).toString("base64")}`,
    //   },
    //   body: JSON.stringify(orderData),
    // });
    
    //     const planData = await subscriptionModel.findById(planId as string)
    //     if(!planData){
    //       throw new HTTP400Error({message: 'Subscription Plan not found'})
    //     }
    //     const subscribePlan = await CompanyService.createUserPlan(req.userId!, planData,razorpayOrderId,razorpaymentId,razorpaySignature)
    //     return successResponse(req,res, 'Plan subscribed successfully', subscribePlan)
    // })
    

    deleteSubscriptionPlan = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const {id} = req.params 
        const deleteSubscription = await subscriptionService.deleteSubscriptionPlan(id)
        return successResponse(req, res, 'Subscription Plan deleted successfully',deleteSubscription, HttpStatusCode.OK);
    })

    getSubscriptionPlanById = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const {id} = req.params 
        const subscriptionPlan = await subscriptionService.getSubscriptionPlanById(id)
        return successResponse(req, res, 'Subscription Plan retrieved successfully', subscriptionPlan, HttpStatusCode.OK);
    })
}

export default new SubscriptionController();