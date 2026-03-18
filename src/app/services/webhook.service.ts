import WebhookModel from '@surefy/console/models/webhook.model';
import WebhookLogModel from '@surefy/console/models/webhookLog.model';
import { CreateWebhookDto, WebhookEvent } from '@surefy/console/interfaces/webhook.interface';
import axios from 'axios';
import * as crypto from 'crypto';

class WebhookService {
  /**
   * Create webhook
   */
  async createWebhook(data: CreateWebhookDto) {
    return WebhookModel.create({
      company_id: data.company_id,
      url: data.url,
      secret: data.secret || crypto.randomBytes(32).toString('hex'),
      events: data.events,
      headers: data.headers || {},
      max_retries: data.max_retries || 3,
      timeout_ms: data.timeout_ms || 10000,
    });
  }

  /**
   * Get webhooks for company
   */
  async getWebhooks(companyId: string) {
    return WebhookModel.findByCompanyId(companyId);
  }

  /**
   * Update webhook
   */
  async updateWebhook(id: string, data: any) {
    return WebhookModel.update(id, { ...data, updated_at: new Date() });
  }

  /**
   * Delete webhook
   */
  async deleteWebhook(id: string) {
    return WebhookModel.update(id, { deleted_at: new Date() });
  }

  buildIncomingWebhookPayload(message: any, phoneNumber: any) {
    return {
      whatsapp: {
        messages: [
          {
            callback_type: "incoming_message",
            metaMessageId: message.wamid,
            sid: message.id, // internal message id
            from: message.from_phone,
            to: message.to_phone,
            timestamp: message.created_at ?? new Date().toISOString(),
            profile_name: message.profile_name, // or fetch if available
            content: message.content,
          },
        ],
      },
    }
  }

  /**
   * Trigger webhook for event
   */
  async triggerWebhook(companyId: string, eventType: string, data: any) {
    // Find active webhooks subscribed to this event
    const webhooks = await WebhookModel.findActiveWebhooks(companyId, eventType);

    for (const webhook of webhooks) {
      // Create webhook log
      const log = await WebhookLogModel.create({
        webhook_id: webhook.id,
        company_id: companyId,
        event_type: eventType,
        payload: data,
        status: 'pending',
        attempt_count: 0,
      });

      // Send webhook asynchronously
      this.sendWebhook(webhook, log.id, eventType, data).catch((error) => {
        console.error(`Failed to send webhook ${webhook.id}:`, error);
      });
    }
  }

  /**
   * Send webhook to endpoint
   */
  private async sendWebhook(webhook: any, logId: string, eventType: string, message: any) {
    const payload = message

    // Generate signature if secret exists
    const headers: any = {
      'Content-Type': 'application/json',
      'X-Webhook-Event': eventType,
      ...webhook.headers,
    };

    if (webhook.secret) {
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(payload))
        .digest('hex');
      headers['X-Webhook-Signature'] = signature;
    }

    const startTime = Date.now();
    let attempt = 0;

    while (attempt <= webhook.max_retries) {
      try {
        const response = await axios.post(webhook.url, payload, {
          headers,
          timeout: webhook.timeout_ms,
          validateStatus: () => true, // Don't throw on any status
        });

        const duration = Date.now() - startTime;

        if (response.status >= 200 && response.status < 300) {
          // Success
          await WebhookLogModel.updateAttempt(logId, 'success', {
            statusCode: response.status,
            body: JSON.stringify(response.data).substring(0, 1000),
            duration,
          });

          await WebhookModel.updateLastTriggered(webhook.id, true);
          return;
        } else {
          // Failed but got response
          if (attempt >= webhook.max_retries) {
            await WebhookLogModel.updateAttempt(logId, 'failed', {
              statusCode: response.status,
              body: JSON.stringify(response.data).substring(0, 1000),
              duration,
              error: `HTTP ${response.status}: ${response.statusText}`,
            });

            await WebhookModel.updateLastTriggered(webhook.id, false);
            return;
          }

          // Retry
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
        }
      } catch (error: any) {
        const duration = Date.now() - startTime;

        if (attempt >= webhook.max_retries) {
          await WebhookLogModel.updateAttempt(logId, 'failed', {
            duration,
            error: error.message,
          });

          await WebhookModel.updateLastTriggered(webhook.id, false);
          return;
        }

        // Retry
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
      }
    }
  }

  /**
   * Get webhook logs
   */
  async getWebhookLogs(webhookId: string, limit: number = 100) {
    return WebhookLogModel.findByWebhookId(webhookId, limit);
  }

  /**
   * Retry failed webhook
   */
  async retryWebhook(logId: string) {
    const log = await WebhookLogModel.findById(logId);
    if (!log) {
      throw new Error('Webhook log not found');
    }

    const webhook = await WebhookModel.findById(log.webhook_id);
    if (!webhook) {
      throw new Error('Webhook not found');
    }

    await WebhookLogModel.update(logId, { status: 'retry', attempt_count: 0 });
    await this.sendWebhook(webhook, logId, log.event_type, log.payload);
  }
}

export default new WebhookService();
