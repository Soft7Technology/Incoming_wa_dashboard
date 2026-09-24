import { Router } from 'express';
import PaymentController from '../app/http/controllers/payment.controller';

const PaymentRoute = Router();
// Checkout sessions and payment details must not be cached.
PaymentRoute.use(PaymentController.noStore);

PaymentRoute.get('/providers', PaymentController.providers);
PaymentRoute.get('/gateways', PaymentController.configurations);
PaymentRoute.put('/gateways', PaymentController.configure);
PaymentRoute.delete('/gateways/:mode', PaymentController.disable);
PaymentRoute.post('/test-orders', PaymentController.createTestOrder);
PaymentRoute.post('/orders', PaymentController.createOrder);
PaymentRoute.get('/orders/:id', PaymentController.getOrder);
PaymentRoute.post('/orders/:id/verify', PaymentController.verifyOrder);

export default PaymentRoute;
