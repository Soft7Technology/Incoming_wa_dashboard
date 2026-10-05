import { Response, NextFunction } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import service from '../../services/superAdmin.service';
import { CompanyCollection } from '../../interfaces/superAdmin.interface';

class SuperAdminController {
  authorize = async (req: JWTAuthRequest, res: Response, next: NextFunction) => {
    try {
      await service.authorize(req.userId);
      next();
    } catch (error) {
      next(error);
    }
  };
  overview = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(req, res, 'Superadmin overview retrieved', await service.overview());
  });
  companies = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(req, res, 'Companies retrieved', await service.companies(req.query));
  });
  company = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(req, res, 'Company details retrieved', await service.company(req.params.companyId));
  });
  companyOverview = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(req, res, 'Company overview retrieved', await service.companyOverview(req.params.companyId));
  });
  userDetails = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(req, res, 'User details retrieved',
      await service.userDetails(req.params.userId, req.params.companyId));
  });
  collection = (resource: CompanyCollection) =>
    tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
      return successResponse(
        req,
        res,
        `${resource} retrieved`,
        await service.collection(resource, req.query, req.params.companyId),
      );
    });
  createCompany = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(
      req,
      res,
      'Company and initial admin created',
      await service.createCompany(req.userId!, req.body),
      HttpStatusCode.CREATED,
    );
  });
  
  updateCompany = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(
      req,
      res,
      'Company updated',
      await service.updateCompany(req.userId!, req.params.companyId, req.body),
    );
  });
  companyStatus = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(
      req,
      res,
      'Company status updated',
      await service.companyStatus(req.userId!, req.params.companyId, req.body),
    );
  });
  deleteCompany = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(
      req,
      res,
      'Company soft deleted',
      await service.deleteCompany(req.userId!, req.params.companyId, req.body),
    );
  });
  updateUser = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(
      req,
      res,
      'User updated',
      await service.updateUser(req.userId!, req.params.companyId, req.params.userId, req.body),
    );
  });
  userStatus = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(
      req,
      res,
      'User status updated',
      await service.updateUser(req.userId!, req.params.companyId, req.params.userId, req.body, true),
    );
  });
  addCredit = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(
      req,
      res,
      'Company credit recorded',
      await service.addCredit(req.userId!, req.params.companyId, req.body),
    );
  });
}
export default new SuperAdminController();
