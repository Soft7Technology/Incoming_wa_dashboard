import { Router, Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import payments from '../app/services/companyPayment.service';

const PaymentRoute = Router();
PaymentRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

PaymentRoute.get('/providers', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'Supported payment gateways', [
    { provider: 'razorpay', name: 'Razorpay', modes: ['test', 'live'], currency: 'INR', key_id_label: 'Key ID', key_secret_label: 'Key Secret' },
    { provider: 'cashfree', name: 'Cashfree', modes: ['test', 'live'], currency: 'INR', key_id_label: 'App ID', key_secret_label: 'Secret Key' },
  ])));

PaymentRoute.get('/gateways', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'Company payment gateways', await payments.configurations(req))));
PaymentRoute.put('/gateways', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'Payment gateway configured', await payments.configure(req, req.body || {}))));
PaymentRoute.delete('/gateways/:mode', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'Payment gateway disabled', await payments.disable(req, req.params.mode))));
PaymentRoute.post('/test-orders', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'Test payment order', await payments.create(req, req.body || {}, true))));
PaymentRoute.post('/orders', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'Payment order', await payments.create(req, req.body || {}))));
PaymentRoute.get('/orders/:id', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'Payment order', await payments.get(req, req.params.id))));
PaymentRoute.post('/orders/:id/verify', tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
  successResponse(req, res, 'Payment status checked with gateway', await payments.verify(req, req.params.id))));

export default PaymentRoute;
