import { BaseModel } from '@surefy/models/base.model';

class CampaignModel extends BaseModel {
  constructor() {
    super('campaigns');
  }

  async findDetailsById(campaignId: string) {
    const phoneIdMatch = this.db.raw('pn.id::text = c.phone_number_id::text');
    return this.query()
      .from('campaigns as c')
      .leftJoin('templates as t', 't.id', 'c.template_id')
      .leftJoin('phone_numbers as pn', function () {
        this.on('pn.phone_number_id', '=', 'c.phone_number_id')
          .orOn(phoneIdMatch);
      })
      .where('c.id', campaignId)
      .select('c.*', 't.name as template_name', 'pn.display_phone_number as phone_number')
      .first();
  }

  async findByUserId(userId: string, filters: any = {}) {
    let query = this.query()
      .whereNull('deleted_at')
      .where((builder) => {
        builder
          .where('user_id', userId)
          .orWhereRaw('assigned_to @> ARRAY[?]::uuid[]', [userId]);
      });

    if (filters.status) {
      query = query.where('status', filters.status);
    }

    if (filters.phone_number_id) {
      query = query.where('phone_number_id', filters.phone_number_id);
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

  async getUserCampaigns(userId: string) {
    const userCampaigns = await this.query().where({ user_id: userId })
    return userCampaigns
  }


  async updateStatus(campaignId: string, status: string, additionalData: any = {}) {
    const updateData: any = { status, ...additionalData };

    if (status === 'scheduled' || status === 'running' || status === 'completed') {
      updateData.failure_reason = null;
    }

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

  async markRunningJobFailed(id: string, reason: string) {
    return this.query().where({ id, status: 'running' })
      .update({ status: 'failed', failure_reason: reason, completed_at: new Date(), updated_at: new Date() });
  }

  async getRunningCampaigns() {
    return this.query()
      .where({ status: 'running' })
      .whereNull('deleted_at');
  }
}

export default new CampaignModel();
