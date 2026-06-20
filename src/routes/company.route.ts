import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';
import companyController from '@surefy/console/http/controllers/company.controller';
import { uploadMediaMiddleware } from '@surefy/middleware/upload.middleware';

const companyRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies

companyRoute.post('/',uploadMediaMiddleware, CompanyController.onboard); 
companyRoute.put('/',uploadMediaMiddleware, CompanyController.updateCompany);
companyRoute.delete('/', CompanyController.deleteCompany);
companyRoute.get('/dashboard', CompanyController.getdashboardStats)
companyRoute.get('/details',companyController.getCompanyDetails)

/**
 * Get All Companies
 */
companyRoute.get('/', CompanyController.getAllCompanies );


/**
 * Companies user route
 */
companyRoute.post('/user',companyController.createUser);
companyRoute.get('/user',companyController.getAllUsers);
companyRoute.put('/user/:id', CompanyController.updateCompanyUser);


companyRoute.get("/subscriptions",CompanyController.getCompaniesSubscription)

companyRoute.get('/:id', CompanyController.getById);
companyRoute.get('/user-details/:userId',companyController.getUserDetails)

companyRoute.post('/:planId/regenerate-keys', CompanyController.regenerateKeys);
companyRoute.get('/stats', CompanyController.getUserStats)
companyRoute.get('/user/plan/:userId', companyController.getUserPlan)

export default companyRoute;