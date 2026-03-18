import { BaseModel } from '@surefy/models/base.model';

class CampaignModel extends BaseModel {
  constructor() {
    super('campaigns');
  }

  async findByCompany(companyId: string, filters: any = {}) {
    let query = this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at');

    if (filters.status) {
      query = query.where({ status: filters.status });
    }

    if (filters.phone_number_id) {
      query = query.where({ phone_number_id: filters.phone_number_id });
    }

    if (filters.search) {
      query = query.where((builder) => {
        builder
          .where('name', 'ilike', `%${filters.search}%`)
          .orWhere('description', 'ilike', `%${filters.search}%`);
      });
    }

    return query.orderBy('created_at', 'desc');
  }


  async updateStatus(campaignId: string, status: string, additionalData: any = {}) {
    const updateData: any = { status, ...additionalData };

    if (status === 'running' && !additionalData.started_at) {
      updateData.started_at = new Date();
    }

    if ((status === 'completed' || status === 'failed') && !additionalData.completed_at) {
      updateData.completed_at = new Date();
    }

    return this.update(campaignId, updateData);
  }

  async updateCounts(campaignId: string, counts: {
    total_recipients?: number;
    sent_count?: number;
    delivered_count?: number;
    read_count?: number;
    failed_count?: number;
    invalid_numbers_count?: number;
    total_cost?: number;
  }) {
    return this.update(campaignId, counts);
  }

  async incrementCount(campaignId: string, field: string, amount: number = 1) {
    return this.query()
      .where({ id: campaignId })
      .increment(field, amount);
  }

  async getScheduledCampaigns() {
    return this.query()
      .where({ status: 'scheduled' })
      .where('scheduled_at', '<=', new Date())
      .whereNull('deleted_at');
  }

  async getRunningCampaigns() {
    return this.query()
      .where({ status: 'running' })
      .whereNull('deleted_at');
  }
}

export default new CampaignModel();
