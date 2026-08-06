import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import cleanupService from '../../services/cleanup.service';

class CleanupController {
  cleanupData = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    // 1. Authorize user (Only admin or superadmin)
    if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
      throw new HTTP400Error({ message: 'Only admin or superadmin can perform database cleanup' });
    }

    const { range } = req.body;
    if (!range) {
      throw new HTTP400Error({ message: 'range parameter is required' });
    }

    const deletedCounts = await cleanupService.cleanupData(range);

    return successResponse(req, res, 'Database cleanup completed successfully', deletedCounts);
  });
}

export default new CleanupController();
