import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';
import companyController from '@surefy/console/http/controllers/company.controller';

const companyRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies
companyRoute.post('/', CompanyController.onboard); // Admin creates new company
companyRoute.post('/user',companyController.createUser);
companyRoute.get('/', CompanyController.getAll);
companyRoute.get('/:id', CompanyController.getById);
companyRoute.put('/:id', CompanyController.update);
companyRoute.delete('/:id', CompanyController.delete);
companyRoute.post('/:id/regenerate-keys', CompanyController.regenerateKeys);
companyRoute.get('/stats', CompanyController.getUserStats)
companyRoute.get('/dashboard', CompanyController.getdashboardStats)
// companyRoute.get('/notifications', CompanyController.getNotifications)

export default companyRoute;