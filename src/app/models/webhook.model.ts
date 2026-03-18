import { BaseModel } from '@surefy/models/base.model';

class WebhookModel extends BaseModel {
  constructor() {
    super('webhooks');
  }

  async findByCompanyId(companyId: string) {
    return this.query().where({ company_id: companyId, deleted_at: null });
  }

  async findActiveWebhooks(companyId: string, eventType: string) {
    return this.query()
      .where({ company_id: companyId, status: 'active', deleted_at: null })
      .whereRaw('events @> ?', [JSON.stringify([eventType])]);
  }

  async updateLastTriggered(id: string, success: boolean) {
    const updateData: any = {
      last_triggered_at: new Date(),
      updated_at: new Date(),
    };

    if (success) {
      updateData.last_success_at = new Date();
      updateData.retry_count = 0;
    } else {
      updateData.last_failure_at = new Date();
    }

    return this.update(id, updateData);
  }
}

export default new WebhookModel();
