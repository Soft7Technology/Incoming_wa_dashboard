import { Router } from 'express';
import MessageController from '@surefy/console/http/controllers/message.controller';

const WebhookPublicRoute = Router();

// Meta Webhook Endpoints (no auth - verified by Meta token)
WebhookPublicRoute.get('/meta', MessageController.verifyWebhook);
WebhookPublicRoute.post('/meta', MessageController.handleWebhook);

export default WebhookPublicRoute;
