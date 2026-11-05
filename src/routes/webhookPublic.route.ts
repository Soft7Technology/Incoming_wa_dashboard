import { Router } from 'express';
import MessageController from '@surefy/console/http/controllers/message.controller';
import { wabaAccountUpdate } from '../app/http/middleware/wabaAccountUpdate';
import creditTopups from '../app/http/controllers/creditTopup.controller';
import payments from '../app/http/controllers/payment.controller';

const WebhookPublicRoute = Router();
WebhookPublicRoute.post('/razorpay/company-payments/:gatewayId', payments.paymentLinkWebhook);
WebhookPublicRoute.post('/razorpay/credits', creditTopups.webhook);
WebhookPublicRoute.get('/razorpay/credits/reference-qr', creditTopups.referenceQr);

// Meta Webhook Endpoints (no auth - verified by Meta token)
WebhookPublicRoute.get('/meta', MessageController.verifyWebhook);
WebhookPublicRoute.post('/meta', wabaAccountUpdate, MessageController.handleWebhook);
// WebhookPublicRoute.post('/razorpay', MessageController.handleRazorpayPayment);

export default WebhookPublicRoute;
