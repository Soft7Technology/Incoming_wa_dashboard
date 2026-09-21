import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync, successResponse } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import UserApiKeyService from '../../services/userApiKey.service';

class UserApiKeyController {
  createKey = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const key = await UserApiKeyService.createKey(req);
    res.setHeader('Cache-Control', 'no-store');
    return successResponse(req, res, 'API key created. Any previous key is revoked. You can view the active key on your dashboard.', key, HttpStatusCode.CREATED);
  });

  getKeys = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const keys = await UserApiKeyService.getKeys(req);
    return successResponse(req, res, 'API keys retrieved', keys);
  });

  revokeKey = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    await UserApiKeyService.revokeKey(req, req.params.id);
    return successResponse(req, res, 'API key revoked');
  });
}

export default new UserApiKeyController();
