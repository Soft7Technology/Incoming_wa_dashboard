import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';

const CompanyRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies
CompanyRoute.post('/', CompanyController.onboard); // Admin creates new company
CompanyRoute.get('/', CompanyController.getAll);
CompanyRoute.get('/:id', CompanyController.getById);
CompanyRoute.put('/:id', CompanyController.update);
CompanyRoute.delete('/:id', CompanyController.delete);
CompanyRoute.post('/:id/regenerate-keys', CompanyController.regenerateKeys);

export default CompanyRoute;
