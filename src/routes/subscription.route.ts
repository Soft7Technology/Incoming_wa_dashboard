import { Router } from 'express';
import SubscriptionController from '@surefy/console/http/controllers/subscription.controller';
import subscriptionController from '@surefy/console/http/controllers/subscription.controller';


// companyRoute.post('/user/:planId/activate-plan', CompanyController.subscribePlan);
// companyRoute.get('/user/plan/:userId', companyController.getUserPlan)
 
const SubscriptionRoute = Router();
 

SubscriptionRoute.get('/plan', SubscriptionController.getSubscription)
SubscriptionRoute.post('/plan',SubscriptionController.createSubscription)
SubscriptionRoute.get('/default-plans',SubscriptionController.getDeafultSubscritionPlan)
SubscriptionRoute.post('/verify-payment',SubscriptionController.activateUserPlanAfterPayment)


SubscriptionRoute.post('/:planId/activate-free-trial',SubscriptionController.activateFreeTrial)
SubscriptionRoute.put('/plan/:id',SubscriptionController.updateSubscriptionPlan)
SubscriptionRoute.delete('/plan/:id',SubscriptionController.deleteSubscriptionPlan)
SubscriptionRoute.get('/plan/:id',SubscriptionController.getSubscriptionPlanById)
SubscriptionRoute.post('/:planId/activate',SubscriptionController.subscribePlan)
SubscriptionRoute.post('/verify-payment',SubscriptionController.activateUserPlanAfterPayment)
SubscriptionRoute.post('/:planId/cancel-plan',subscriptionController.cancelUserSubscriptionPlan)

export default SubscriptionRoute;

