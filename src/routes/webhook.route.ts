import { Router } from 'express';
import WebhookController from '@surefy/console/http/controllers/webhook.controller';

const WebhookRoute = Router();

// Webhook Management - for managing webhooks sent to clients
// JWT authentication applied at route group level (admin only)
WebhookRoute.post('/', WebhookController.createWebhook);
WebhookRoute.get('/', WebhookController.getWebhooks);
WebhookRoute.put('/:id', WebhookController.updateWebhook);
WebhookRoute.delete('/:id', WebhookController.deleteWebhook);
WebhookRoute.get('/:id/logs', WebhookController.getWebhookLogs);
WebhookRoute.post('/logs/:logId/retry', WebhookController.retryWebhook);

export default WebhookRoute;
