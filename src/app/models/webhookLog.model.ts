import { BaseModel } from '@surefy/models/base.model';

class WebhookLogModel extends BaseModel {
  constructor() {
    super('webhook_logs');
  }

  async findByWebhookId(webhookId: string, limit: number = 100) {
    return this.query()
      .where({ webhook_id: webhookId })
      .orderBy('created_at', 'desc')
      .limit(limit);
  }

  async findPendingLogs(limit: number = 100) {
    return this.query()
      .whereIn('status', ['pending', 'retry'])
      .orderBy('created_at', 'asc')
      .limit(limit);
  }

  async updateAttempt(id: string, status: string, responseData: any = {}) {
    const updateData: any = {
      status,
      updated_at: new Date(),
    };

    if (status === 'success' || status === 'failed') {
      updateData.sent_at = new Date();
      updateData.response_status_code = responseData.statusCode;
      updateData.response_body = responseData.body;
      updateData.duration_ms = responseData.duration;

      if (status === 'failed') {
        updateData.error_message = responseData.error;
      }
    }

    return this.query()
      .where({ id })
      .increment('attempt_count', 1)
      .update(updateData)
      .returning('*');
  }
}

export default new WebhookLogModel();
