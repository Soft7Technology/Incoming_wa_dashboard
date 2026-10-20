import { Router } from 'express';
import SubscriptionController from '@surefy/console/http/controllers/subscription.controller';
import subscriptionController from '@surefy/console/http/controllers/subscription.controller';
import planCatalog from '../app/http/controllers/planCatalog.controller';
import pricing from '../app/http/controllers/platformPricing.controller';
import planExtension from '../app/http/controllers/planExtension.controller';

// companyRoute.post('/user/:planId/activate-plan', CompanyController.subscribePlan);
// companyRoute.get('/user/plan/:userId', companyController.getUserPlan)

const SubscriptionRoute = Router();
SubscriptionRoute.get('/plan-options', planCatalog.planOptions);
SubscriptionRoute.get('/charges', pricing.charges);
SubscriptionRoute.get('/trial-policy', planCatalog.trialPolicy);

SubscriptionRoute.get('/features', planCatalog.features);
SubscriptionRoute.post('/features', planCatalog.createFeature);
SubscriptionRoute.get('/addons', planCatalog.addons);
SubscriptionRoute.post('/addons', planCatalog.createAddon);
SubscriptionRoute.patch('/addons/:id', planCatalog.updateCompanyAddon);
SubscriptionRoute.delete('/addons/:id', planCatalog.disableAddon);
SubscriptionRoute.post('/addon-purchases', planCatalog.purchase);
SubscriptionRoute.get('/entitlements', planCatalog.entitlements);
SubscriptionRoute.post('/user-plans/:userPlanId/extend', planExtension.extend);

SubscriptionRoute.get('/plan', SubscriptionController.getSubscription);
SubscriptionRoute.post('/plan', SubscriptionController.createSubscription);
SubscriptionRoute.get('/default-plans', SubscriptionController.getDeafultSubscritionPlan);
// Verify a local company payment order; activates its pending user plan only after provider confirmation.
SubscriptionRoute.post('/verify-payment', SubscriptionController.activateUserPlanAfterPayment);

SubscriptionRoute.post('/:planId/activate-free-trial', SubscriptionController.activateFreeTrial);
SubscriptionRoute.put('/plan/:id', SubscriptionController.updateSubscriptionPlan);
SubscriptionRoute.delete('/plan/:id', SubscriptionController.deleteSubscriptionPlan);
SubscriptionRoute.get('/plan/:id', SubscriptionController.getSubscriptionPlanById);
// Creates a pending plan/order, not immediate access. Requires Idempotency-Key.
SubscriptionRoute.post('/:planId/activate', SubscriptionController.subscribePlan);
SubscriptionRoute.post('/:planId/cancel-plan', subscriptionController.cancelUserSubscriptionPlan);

export default SubscriptionRoute;
