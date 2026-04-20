import { Router } from 'express';
import SubscriptionController from '@surefy/console/http/controllers/subscription.controller';

 
const SubscriptionRoute = Router();
 
// SubscriptionRoute.get('/active-plans', SubscriptionController.getActiveSubscriptionPlans) 
SubscriptionRoute.get('/plan', SubscriptionController.getSubscription)
SubscriptionRoute.post('/plan',SubscriptionController.createSubscription)
SubscriptionRoute.post('/subscribe')
SubscriptionRoute.post('/unsubscribe')
SubscriptionRoute.get('/status')
SubscriptionRoute.get('/invoices')
SubscriptionRoute.put('/plan/:id',SubscriptionController.updateSubscriptionPlan)
SubscriptionRoute.delete('/plan/:id',SubscriptionController.deleteSubscriptionPlan)
SubscriptionRoute.get('/plan/:id',SubscriptionController.getSubscriptionPlanById)

export default SubscriptionRoute;

