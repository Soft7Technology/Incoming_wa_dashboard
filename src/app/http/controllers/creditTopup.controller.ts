import { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import topups, { CreditTopupActor } from '../../services/creditTopup.service';

const actor = (req: JWTAuthRequest): CreditTopupActor => ({ userId: req.userId, companyId: req.companyId,
  userRole: req.userRole, idempotencyKey: req.get('Idempotency-Key') });

class CreditTopupController {
  noStore = (_req: Request, res: Response, next: NextFunction) => { res.setHeader('Cache-Control', 'no-store'); next(); };
  options = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Credit purchase options', topups.options(actor(req))));
  create = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Credit payment QR created', await topups.create(actor(req), req.body || {}), 201));
  list = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Company credit purchases', await topups.list(actor(req), req.query)));
  get = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Credit purchase status', await topups.get(actor(req), req.params.id)));
  verify = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Payment checked with Razorpay', await topups.verify(actor(req), req.params.id, req.body || {})));
  webhook = tryCatchAsync(async (req: Request & { rawBody?: Buffer }, res: Response) =>
    successResponse(req, res, 'Razorpay credit event received',
      await topups.webhook(req.rawBody, req.get('X-Razorpay-Signature'), req.get('X-Razorpay-Event-Id'))));
  referenceQr = (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.type('image/jpeg').sendFile(path.resolve(__dirname, '../../../web/credits/soft7-reference-qr.jpeg'));
  };
}
export default new CreditTopupController();
