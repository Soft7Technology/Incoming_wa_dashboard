import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';
import companyController from '@surefy/console/http/controllers/company.controller';

const companyRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies

companyRoute.post('/', CompanyController.onboard); 
companyRoute.put('/', CompanyController.updateCompany);
companyRoute.delete('/', CompanyController.deleteCompany);
companyRoute.get('/dashboard', CompanyController.getdashboardStats)
companyRoute.get('/',companyController.getCompanyDetails)
// companyRoute.get('/admin', companyController.getAdminUsers);

companyRoute.get('/', CompanyController.getAll);

companyRoute.post('/user',companyController.createUser);
companyRoute.get('/user',companyController.getAllUsers);
companyRoute.put('/user/:id', CompanyController.updateCompanyUser);
companyRoute.get("/subscriptions",CompanyController.getCompaniesSubscription)

// companyRoute.get('/:id', CompanyController.getById);
companyRoute.get('/user-details/:userId',companyController.getUserDetails)
// companyRoute.get("/user/:userId/",CompanyController.getUserById)

companyRoute.post('/:planId/regenerate-keys', CompanyController.regenerateKeys);
companyRoute.get('/stats', CompanyController.getUserStats)
companyRoute.get('/user/plan/:userId', companyController.getUserPlan)

export default companyRoute;