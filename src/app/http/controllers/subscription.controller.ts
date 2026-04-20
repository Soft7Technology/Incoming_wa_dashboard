import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import MessageService from '@surefy/console/services/message.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import subscriptionService from "../../services/subscription.service"

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

        const updatedSubscription = await subscriptionService.updateSubscriptionPlan(id,{plan_name,price,billing_cycle,description,active,features})
        return successResponse(req, res, 'Subscription Plan updated successfully', updatedSubscription, HttpStatusCode.OK);
    })

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