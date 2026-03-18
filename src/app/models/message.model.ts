import { BaseModel } from '@surefy/models/base.model';

class MessageModel extends BaseModel {
  constructor() {
    super('messages');
  }

  async findByCompanyId(companyId: string, filters: any = {}) {
    let query = this.query().where({ company_id: companyId });

    if (filters.status) {
      query.where({ status: filters.status });
    }

    if (filters.direction) {
      query.where({ direction: filters.direction });
    }

    if (filters.type) {
      query.where({ type: filters.type });
    }

    if (filters.phone_number_id) {
      query.where({ phone_number_id: filters.phone_number_id });
    }

    if (filters.from_date) {
      query.where('created_at', '>=', filters.from_date);
    }

    if (filters.to_date) {
      query.where('created_at', '<=', filters.to_date);
    }

    if (filters.search) {
      query.where((builder) => {
        builder
          .where('from_phone', 'like', `%${filters.search}%`)
          .orWhere('to_phone', 'like', `%${filters.search}%`)
          .orWhereRaw(`content::text ILIKE ?`, [`%${filters.search}%`]);
      });
    }

    // Get total count for pagination
    const totalQuery = query.clone();
    const [{ count }] = await totalQuery.count('* as count');
    const total = parseInt(count as string, 10);

    // Apply sorting
    const sortBy = filters.sort_by || 'created_at';
    const sortOrder = filters.sort_order || 'desc';
    query.orderBy(sortBy, sortOrder);

    // Apply pagination
    const page = parseInt(filters.page || '1', 10);
    const limit = parseInt(filters.limit || '20', 10);
    const offset = (page - 1) * limit;

    query.limit(limit).offset(offset);

    const messages = await query;

    return {
      data: messages,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: page < Math.ceil(total / limit),
        has_prev: page > 1,
      },
    };
  }

  async findByWamid(wamid: string) {
    return this.query().where({ wamid }).first();
  }

  async updateStatus(wamid: string, status: string, additionalData: any = {}) {
    const updateData: any = { status, updated_at: new Date() };

    if (status === 'sent') {
      updateData.sent_at = new Date();
    } else if (status === 'delivered') {
      updateData.delivered_at = new Date();
    } else if (status === 'read') {
      updateData.read_at = new Date();
    } else if (status === 'failed') {
      updateData.failed_at = new Date();
      if (additionalData.error_message) {
        updateData.error_message = additionalData.error_message;
        updateData.error_code = additionalData.error_code;
      }
    }

    return this.query().where({ wamid }).update(updateData).returning('*');
  }

  async getMessageStats(companyId: string, fromDate?: Date, toDate?: Date) {
    const query = this.query()
      .where({ company_id: companyId })
      .select(this.db.raw(`
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN status = 'read' THEN 1 END) as read,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      `));

    if (fromDate) {
      query.where('created_at', '>=', fromDate);
    }

    if (toDate) {
      query.where('created_at', '<=', toDate);
    }

    return query.first();
  }
}

export default new MessageModel();
