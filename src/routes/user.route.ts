import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';
import companyController from '@surefy/console/http/controllers/company.controller';


const UserRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies
UserRoute.post('/create', CompanyController.createUser); // Admin creates new user under company
UserRoute.get('/stats', CompanyController.getUserStats)

UserRoute.get('/', CompanyController.getUser);
UserRoute.get('/reminder',CompanyController.getReminders)



UserRoute.get('/plan/status', CompanyController.checkUserPlanStatus)

//To check if the user has existing free plan
UserRoute.get('/plans',companyController.getAllUserPlans)

UserRoute.put('/:userId/suspend-plan', companyController.suspendUserPlan)
UserRoute.put('/:id/suspend-user',companyController.suspendUser)
UserRoute.put('/:id/active-user',companyController.activateUser)
UserRoute.put('/:id/reset-password', CompanyController.resetUserPassword);
UserRoute.put('/:id', CompanyController.updateUser);
UserRoute.delete('/:id', CompanyController.deleteCompanyUser);
UserRoute.post('/:id/regenerate-keys', CompanyController.regenerateKeys);



export default UserRoute;