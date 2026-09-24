import { Response, NextFunction } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import payments, { PaymentContext } from '../../services/companyPayment.service';

// Only authenticated identity and the retry key cross the HTTP/service boundary.
function paymentContext(req: JWTAuthRequest): PaymentContext {
  return {
    userId: req.userId,
    companyId: req.companyId,
    userRole: req.userRole,
    idempotencyKey: req.get('Idempotency-Key'),
  };
}

class PaymentController {
  noStore = (_req: JWTAuthRequest, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  providers = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = payments.providers();
    return successResponse(req, res, 'Supported payment gateways', result);
  });

  configurations = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await payments.configurations(paymentContext(req));
    return successResponse(req, res, 'Company payment gateways', result);
  });

  configure = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await payments.configure(paymentContext(req), req.body || {});
    return successResponse(req, res, 'Payment gateway configured', result);
  });

  disable = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await payments.disable(paymentContext(req), req.params.mode);
    return successResponse(req, res, 'Payment gateway disabled', result);
  });

  createTestOrder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await payments.create(paymentContext(req), req.body || {}, true);
    return successResponse(req, res, 'Test payment order', result);
  });

  createOrder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await payments.create(paymentContext(req), req.body || {});
    return successResponse(req, res, 'Payment order', result);
  });

  getOrder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await payments.get(paymentContext(req), req.params.id);
    return successResponse(req, res, 'Payment order', result);
  });

  verifyOrder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await payments.verify(paymentContext(req), req.params.id);
    return successResponse(req, res, 'Payment status checked with gateway', result);
  });
}

export default new PaymentController();
