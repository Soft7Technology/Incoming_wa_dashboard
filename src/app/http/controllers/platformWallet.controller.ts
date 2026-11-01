import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import credit from '../../services/credit.service';

class PlatformWalletController {
  balance = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(req, res, 'Platform wallet retrieved', await credit.getPlatformBalance(req.userId!));
  });

  transactions = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    return successResponse(req, res, 'Platform fee history retrieved', await credit.getPlatformTransactions(req.userId!, req.query));
  });
}

export default new PlatformWalletController();
