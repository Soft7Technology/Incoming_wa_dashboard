import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import service from '../../services/superAdminOperations.service';
import { ReportResource } from '../../interfaces/superAdminOperations.interface';

class SuperAdminOperationsController {
  forwarded = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(
      req,
      res,
      'Forwarded tickets retrieved',
      await service.list('tickets', { ...req.query, forwarded: 'true' }),
    ),
  );
  escalate = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(
      req,
      res,
      'Ticket forwarded',
      await service.escalate(req.userId!, req.companyId, req.userRole, req.params.ticketId, req.body),
    ),
  );
  overview = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Subscription overview retrieved', await service.overview(req.query)),
  );
  revenue = (byCompany = false) =>
    tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
      successResponse(req, res, 'Revenue report retrieved', await service.revenue(req.query, byCompany)),
    );
  list = (resource: ReportResource) =>
    tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
      successResponse(req, res, `${resource} retrieved`, await service.list(resource, req.query)),
    );
  companyList = (resource: 'plans' | 'active_plans') =>
    tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
      successResponse(
        req,
        res,
        resource === 'plans' ? 'Company subscription plans retrieved' : 'Company active user plans retrieved',
        await service.companyList(resource, req.params.companyId, req.query),
      ),
    );
  conversation = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(
      req,
      res,
      'Ticket conversation retrieved',
      await service.conversation(req.params.ticketId, req.query),
    ),
  );
  changeTicket = (action: 'forward' | 'reply' | 'status') =>
    tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
      successResponse(
        req,
        res,
        'Ticket updated',
        await service.changeTicket(req.userId!, req.params.ticketId, action, req.body),
      ),
    );
}
export default new SuperAdminOperationsController();
