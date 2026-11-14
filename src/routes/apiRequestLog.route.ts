import { Router, Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync, successResponse } from '@surefy/utils/Controller';
import ApiRequestLogService from '../app/services/apiRequestLog.service';

const route = Router();
route.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
route.get('/', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'API requests retrieved', await ApiRequestLogService.list(req, req.query))));
route.get('/summary', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'API usage retrieved', await ApiRequestLogService.summary(req, req.query))));
route.get('/messages', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'API messages retrieved', await ApiRequestLogService.list(req, req.query, true))));
route.get('/:id', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'API request retrieved', await ApiRequestLogService.detail(req, req.params.id))));
export default route;
