import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';
import companyController from '@surefy/console/http/controllers/company.controller';
import { uploadMediaMiddleware } from '@surefy/middleware/upload.middleware';
import { requireRole } from '@surefy/middleware/jwtAuth.middleware';

const companyRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies

companyRoute.post('/', uploadMediaMiddleware, CompanyController.onboard);
companyRoute.put('/:companyId', uploadMediaMiddleware, CompanyController.updateCompany);
companyRoute.put('/', uploadMediaMiddleware, CompanyController.updateCompany);
companyRoute.delete('/:companyId', CompanyController.deleteCompany);
companyRoute.delete('/', CompanyController.deleteCompany);
companyRoute.put('/:companyId/suspend', requireRole('superadmin'), companyController.suspendCompany);
companyRoute.put('/:companyId/active', requireRole('superadmin'), companyController.activeCompany);
companyRoute.get('/dashboard', CompanyController.getdashboardStats);
companyRoute.get('/details', companyController.getCompanyDetails);

/**
 * Get All Companies
 */
companyRoute.get('/', CompanyController.getAllCompanies);

/**
 * Companies user route
 */
companyRoute.post('/user', companyController.createUser);
companyRoute.get('/user', companyController.getAllUsers);
companyRoute.put('/user/:id', CompanyController.updateCompanyUser);
companyRoute.get('/user/:userId',companyController.getCompanyUser)



companyRoute.get('/subscriptions', CompanyController.getCompaniesSubscription);
companyRoute.get('/stats', CompanyController.getUserStats);
companyRoute.get('/user/plan/:userId', companyController.getUserPlan);
companyRoute.get('/user-details/:userId', companyController.getUserDetails);
companyRoute.get('/:id', CompanyController.getById);
companyRoute.post('/:planId/regenerate-keys', CompanyController.regenerateKeys);

export default companyRoute;