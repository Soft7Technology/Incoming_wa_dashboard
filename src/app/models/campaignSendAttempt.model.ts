import { BaseModel } from '@surefy/models/base.model';

class CampaignSendAttemptModel extends BaseModel {
  constructor() { super('campaign_send_attempts'); }

  /** Unique identity is independent of contact rows, job IDs, and worker processes. */
  async reserve(companyId: string, campaignId: string, phoneNumberId: string, recipient: string): Promise<boolean> {
    const rows = await this.query().insert({
      company_id: companyId, campaign_id: campaignId, phone_number_id: phoneNumberId, recipient,
    }).onConflict(['company_id', 'campaign_id', 'phone_number_id', 'recipient']).ignore().returning('campaign_id');
    return rows.length === 1;
  }
}
export default new CampaignSendAttemptModel();
