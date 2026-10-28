import { Router } from 'express';
import MessageController from '@surefy/console/http/controllers/message.controller';
import { wabaAccountUpdate } from '../app/http/middleware/wabaAccountUpdate';

const WebhookPublicRoute = Router();

// Meta Webhook Endpoints (no auth - verified by Meta token)
WebhookPublicRoute.get('/meta', MessageController.verifyWebhook);
WebhookPublicRoute.post('/meta', wabaAccountUpdate, MessageController.handleWebhook);
// WebhookPublicRoute.post('/razorpay', MessageController.handleRazorpayPayment);

export default WebhookPublicRoute;
