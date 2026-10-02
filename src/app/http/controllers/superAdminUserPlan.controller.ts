import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import service from '../../services/superAdminUserPlan.service';

class SuperAdminUserPlanController {
  details = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'User plan retrieved',
      await service.details(req.params.companyId, req.params.userId, req.params.userPlanId)));
  available = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Available company plans retrieved',
      await service.available(req.params.companyId, req.params.userId, req.query)));
  availableForCompany = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Available company plans retrieved',
      await service.availableForCompany(req.query)));
  assign = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await service.assign(req.userId!, req.params.companyId, req.params.userId, req.body);
    return successResponse(req, res, 'User plan assigned', { user: {
      id: result.user.id, company_id: result.user.company_id, assigned_plan: result.user.assigned_plan,
    }, plan: result.plan });
  });
  changeStatus = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'User plan status updated',
      await service.changeStatus(req.userId!, req.params.companyId, req.params.userId, req.params.userPlanId, req.body)));
}
export default new SuperAdminUserPlanController();
