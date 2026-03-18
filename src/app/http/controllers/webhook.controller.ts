import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import WebhookService from '@surefy/console/services/webhook.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class WebhookController {
  /**
   * POST /v1/webhooks
   * Create webhook
   */
  createWebhook = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { url, secret, events, headers, max_retries, timeout_ms } = req.body;

    if (!url || !events || !Array.isArray(events) || events.length === 0) {
      throw new HTTP400Error({ message: 'URL and events are required' });
    }

    const webhook = await WebhookService.createWebhook({
      company_id: req.companyId!,
      url,
      secret,
      events,
      headers,
      max_retries,
      timeout_ms,
    });

    return successResponse(req, res, 'Webhook created successfully', webhook, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/webhooks
   * Get all webhooks for company
   */
  getWebhooks = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const webhooks = await WebhookService.getWebhooks(req.companyId!);
    return successResponse(req, res, 'Webhooks retrieved successfully', webhooks);
  });

  /**
   * PUT /v1/webhooks/:id
   * Update webhook
   */
  updateWebhook = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const webhook = await WebhookService.updateWebhook(id, req.body);
    return successResponse(req, res, 'Webhook updated successfully', webhook);
  });

  /**
   * DELETE /v1/webhooks/:id
   * Delete webhook
   */
  deleteWebhook = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await WebhookService.deleteWebhook(id);
    return successResponse(req, res, 'Webhook deleted successfully');
  });

  /**
   * GET /v1/webhooks/:id/logs
   * Get webhook logs
   */
  getWebhookLogs = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { limit } = req.query;

    const logs = await WebhookService.getWebhookLogs(id, limit ? parseInt(limit as string) : 100);
    return successResponse(req, res, 'Webhook logs retrieved successfully', logs);
  });

  /**
   * POST /v1/webhooks/logs/:logId/retry
   * Retry failed webhook
   */
  retryWebhook = tryCatchAsync(async (req: Request, res: Response) => {
    const { logId } = req.params;
    await WebhookService.retryWebhook(logId);
    return successResponse(req, res, 'Webhook retry initiated');
  });
}

export default new WebhookController();
