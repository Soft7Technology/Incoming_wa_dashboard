import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';
import companyController from '@surefy/console/http/controllers/company.controller';
import { uploadMediaMiddleware } from '@surefy/middleware/upload.middleware';

const companyRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies

companyRoute.post('/',uploadMediaMiddleware, CompanyController.onboard); 
companyRoute.put('/:companyId', uploadMediaMiddleware, CompanyController.updateCompany);
companyRoute.put('/',uploadMediaMiddleware, CompanyController.updateCompany);
companyRoute.delete('/:companyId', CompanyController.deleteCompany);
companyRoute.delete('/', CompanyController.deleteCompany);
companyRoute.get('/dashboard', CompanyController.getdashboardStats)
companyRoute.get('/details',companyController.getCompanyDetails)

/**
 * Get All Companies
 */
companyRoute.get('/', CompanyController.getAll);


/**
 * Companies user route
 */
companyRoute.post('/user',companyController.createUser);
companyRoute.get('/user',companyController.getAllUsers);
companyRoute.get("/subscriptions",CompanyController.getCompaniesSubscription)
companyRoute.get('/stats', CompanyController.getUserStats)
companyRoute.get('/user/plan/:userId', companyController.getUserPlan)


companyRoute.get('/user/:userId', CompanyController.getUserById);
companyRoute.get('/user-details/:userId',companyController.getUserDetails)
companyRoute.put('/user/:companyId', CompanyController.updateCompanyUser);

companyRoute.post('/:planId/regenerate-keys', CompanyController.regenerateKeys);

export default companyRoute;