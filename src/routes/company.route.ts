import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';
import companyController from '@surefy/console/http/controllers/company.controller';

const companyRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies
companyRoute.post('/', CompanyController.onboard); // Admin creates new company
companyRoute.get('/admin', companyController.getAdminUsers);

companyRoute.get('/dashboard', CompanyController.getdashboardStats)
companyRoute.get('/', CompanyController.getAll);

companyRoute.post('/user',companyController.createUser);
companyRoute.get('/user',companyController.getAllUsers);
companyRoute.put('/:id', CompanyController.updateCompanyUser);

companyRoute.get('/:id', CompanyController.getById);
companyRoute.put('/:id', CompanyController.update);
companyRoute.delete('/:id', CompanyController.delete);

companyRoute.post('/:planId/regenerate-keys', CompanyController.regenerateKeys);

companyRoute.get('/stats', CompanyController.getUserStats)
companyRoute.post('/user/:planId/activate-plan', CompanyController.subscribePlan);
companyRoute.get('/user/plan', companyController.getUserPlan)

// companyRoute.get('/notifications', CompanyController.getNotifications)

//Company Users


export default companyRoute;