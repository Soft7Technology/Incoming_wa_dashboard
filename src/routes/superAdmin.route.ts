import operations from '../app/http/controllers/superAdminOperations.controller';
import { Router } from 'express';
import { jwtAuthMiddleware } from '@surefy/middleware/jwtAuth.middleware';
import controller from '../app/http/controllers/superAdmin.controller';
import userPlans from '../app/http/controllers/superAdminUserPlan.controller';

const SuperAdminRoute = Router();
// Every route checks the actor's live database role. API keys cannot enter this group.
SuperAdminRoute.use(jwtAuthMiddleware, controller.authorize);
SuperAdminRoute.get('/overview', controller.overview);
SuperAdminRoute.get('/companies', controller.companies);
SuperAdminRoute.post('/companies', controller.createCompany);
SuperAdminRoute.get('/companies/:companyId', controller.company);
SuperAdminRoute.patch('/companies/:companyId', controller.updateCompany);
SuperAdminRoute.patch('/companies/:companyId/status', controller.companyStatus);
SuperAdminRoute.delete('/companies/:companyId', controller.deleteCompany);
SuperAdminRoute.patch('/companies/:companyId/users/:userId', controller.updateUser);
SuperAdminRoute.patch('/companies/:companyId/users/:userId/status', controller.userStatus);
SuperAdminRoute.get('/companies/:companyId/users/:userId/available-plans', userPlans.available);
SuperAdminRoute.post('/companies/:companyId/users/:userId/plans', userPlans.assign);
SuperAdminRoute.get('/companies/:companyId/users/:userId/plans/:userPlanId', userPlans.details);
SuperAdminRoute.patch('/companies/:companyId/users/:userId/plans/:userPlanId/status', userPlans.changeStatus);
SuperAdminRoute.post('/companies/:companyId/credits', controller.addCredit);

for (const resource of ['users', 'domains', 'activities', 'credits', 'audit'] as const) {
  SuperAdminRoute.get(`/${resource}`, controller.collection(resource));
  SuperAdminRoute.get(`/companies/:companyId/${resource}`, controller.collection(resource));
}
SuperAdminRoute.get('/subscriptions/revenue', operations.revenue());
SuperAdminRoute.get('/subscriptions/revenue/companies', operations.revenue(true));
SuperAdminRoute.get('/subscriptions', operations.list('subscriptions'));
SuperAdminRoute.get('/subscription-plans', operations.list('plans'));
SuperAdminRoute.get('/payments', operations.list('payments'));
SuperAdminRoute.get('/tickets/forward', (req, res, next) => {
  // Express query is mutable in this project's Express 4 runtime.
  req.query.forwarded = 'true';
  next();
}, operations.list('tickets'));

SuperAdminRoute.get('/tickets', operations.list('tickets'));
SuperAdminRoute.get('/tickets/:ticketId/forward', operations.conversation);
SuperAdminRoute.get('/tickets/:ticketId/conversations', operations.conversation);
SuperAdminRoute.post('/tickets/:ticketId/forward', operations.changeTicket('forward'));
SuperAdminRoute.post('/tickets/:ticketId/forward/reply', operations.changeTicket('reply'));
SuperAdminRoute.patch('/tickets/:ticketId/status', operations.changeTicket('status'));

export default SuperAdminRoute;
