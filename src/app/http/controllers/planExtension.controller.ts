import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import planExtension from '../../services/planExtension.service';

export default {
  extend: tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await planExtension.extend({ userId: req.userId, companyId: req.companyId, userRole: req.userRole },
      req.params.userPlanId, req.body);
    return successResponse(req, res, 'Subscription extended successfully', result);
  }),
};
