import { BaseModel } from '@surefy/models/base.model';

class CampaignMessageModel extends BaseModel {
  constructor() {
    super('campaign_messages');
  }

  async findByCampaign(campaignId: string, filters: any = {}) {
    let query = this.query().where({ campaign_id: campaignId });

    if (filters.status) {
      query = query.where({ status: filters.status });
    }

    return query.orderBy('created_at', 'desc');
  }

  async findByContact(contactId: string) {
    return this.query()
      .where({ contact_id: contactId })
      .orderBy('created_at', 'desc');
  }

  async findByMessageId(messageId: string) {
    return this.query()
      .where({ message_id: messageId })
      .first();
  }

  async findPendingByContactId(contactId: string) {
    return this.query()
      .where({ contact_id: contactId, status: 'pending' });
  }

  async getPendingMessages(campaignId: string, limit:number) {
    return this.query()
      .where({ campaign_id: campaignId, status: 'pending' })
      .limit(limit);
  }

  async updateStatus(id: string, status: string, data: any = {}) {
    const updateData: any = { status, ...data };

    if (status === 'sent' && !data.sent_at) {
      updateData.sent_at = new Date();
    }

    if (status === 'delivered' && !data.delivered_at) {
      updateData.delivered_at = new Date();
    }

    if (status === 'read' && !data.read_at) {
      updateData.read_at = new Date();
    }

    if (status === 'failed' && !data.failed_at) {
      updateData.failed_at = new Date();
    }

    return this.update(id, updateData);
  }

  async bulkCreate(messages: any[]) {
    const BATCH_SIZE = 200;
    const results = [];

    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);

      const inserted = await this.query()
        .insert(batch)
        .returning('*');

      results.push(...inserted);
    }

    return results;
  }


  async getCampaignStats(campaignId: string) {
    return this.query()
      .from('campaign_messages as cm')
      .join('messages as m', 'm.id', 'cm.message_id')
      .where('cm.campaign_id', campaignId)
      .select(
        this.db.raw(`COUNT(*) FILTER (WHERE cm.status = 'sent')     AS sent_count`),
        this.db.raw(`COUNT(*) FILTER (WHERE cm.status = 'pending')  AS pending_count`),
        this.db.raw(`COUNT(*) FILTER (WHERE m.status = 'delivered') AS delivered_count`),
        this.db.raw(`COUNT(*) FILTER (WHERE m.status = 'read')      AS read_count`),
        this.db.raw(`COUNT(*) FILTER (WHERE m.status = 'failed')    AS failed_count`)
      )
      .first();
  }

async getCampaignMessageStatus(
  campaignId: string,
  status?: string,
  page: number = 1,
  pageSize: number = 10
) {
  const offset = (page - 1) * pageSize;

  // ---------- BASE QUERY ----------
  const baseQuery = this.query()
    .from('campaign_messages as cm')
    .join('messages as m', 'm.id', 'cm.message_id')
    .join('contacts as c', 'c.id', 'cm.contact_id')
    .join('campaigns as ca', 'ca.id', 'cm.campaign_id')
    .join('templates as t', 't.id', 'ca.template_id')
    .where('cm.campaign_id', campaignId);

  if (status) {
    baseQuery.andWhere('m.status', status);
  }

  // ---------- TOTAL COUNT ----------
  const [{ count }] = await baseQuery
    .clone()
    .clearSelect()
    .count('* as count');

  const total = Number(count);

  // ---------- PAGINATED DATA ----------
  const data = await baseQuery
    .clone()
    .select(
      this.db.raw(`c.attributes ->> 'fullName' AS "leadName"`),
      this.db.raw(`REPLACE(c.phone_number, '+', '') AS "phoneNumber"`),
      'm.status as messageStatus',
      'm.from_phone as fromPhone',
      'm.to_phone as toPhone',
      't.name as templateName',
      'cm.template_variables as templateVariables',
      'm.cost as messageCost',
      'm.error_message as campaignError',
      'cm.error_message as messageError',
      'm.read_at as readAt',
      'm.delivered_at as deliveredAt',
      'm.failed_at as failedAt',
      'm.created_at as sentAt'
    )
    .limit(pageSize)
    .offset(offset)
    .orderBy('m.created_at', 'desc');

  // ---------- PAGINATION META ----------
  const totalPages = Math.ceil(total / pageSize);

  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1
    }
  };
}

}

export default new CampaignMessageModel();
