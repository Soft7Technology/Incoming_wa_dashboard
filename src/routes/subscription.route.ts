import { Router } from 'express';
import SubscriptionController from '@surefy/console/http/controllers/subscription.controller';


// companyRoute.post('/user/:planId/activate-plan', CompanyController.subscribePlan);
// companyRoute.get('/user/plan/:userId', companyController.getUserPlan)
 
const SubscriptionRoute = Router();
 
// SubscriptionRoute.get('/active-plans', SubscriptionController.getActiveSubscriptionPlans) 
SubscriptionRoute.get('/plan', SubscriptionController.getSubscription)
SubscriptionRoute.post('/plan',SubscriptionController.createSubscription)
SubscriptionRoute.get('/default-plans',SubscriptionController.getDeafultSubscritionPlan)
SubscriptionRoute.put('/plan/:id',SubscriptionController.updateSubscriptionPlan)
SubscriptionRoute.delete('/plan/:id',SubscriptionController.deleteSubscriptionPlan)
SubscriptionRoute.get('/plan/:id',SubscriptionController.getSubscriptionPlanById)
SubscriptionRoute.post('/:planId/activate-plan',SubscriptionController.subscribePlan)

export default SubscriptionRoute;

