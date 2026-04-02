import { BaseModel } from '@surefy/models/base.model';

class MessageModel extends BaseModel {
  constructor() {
    super('messages');
  }

  async findByCompanyId(companyId: string,userId:string, filters: any = {}) {
    let query = this.query().where({ company_id: companyId });

    if (filters.status) {
      query.where({ status: filters.status });
    }

    if(filters.userId){
      query.where({user_id:filters.userId})
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

  async findByUserId(companyId: string,userId:string, filters: any = {}) {
    let query = this.query().where({ company_id: companyId });

    if (filters.status) {
      query.where({ status: filters.status });
    }

    if(filters.userId){
      query.where({user_id:filters.userId})
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

async getMessagesConversation(userId: string, phone_number_id: string) {
  console.log("User Id",userId)
  const query = this.query();

  // ✅ FULL normalization (BEST)
  const normalizedToPhoneSQL = `REGEXP_REPLACE(to_phone, '[^0-9]', '', 'g')`;

  // 🔹 Subquery: latest message per unique phone
  const lastMessages = this.query()
    .select([
      'phone_number_id',
      'direction',

      this.db.raw(`type AS "lastMessageType"`),
      this.db.raw(`status AS "lastMessageStatus"`),

      // normalize phones
      this.db.raw(`REGEXP_REPLACE(from_phone, '[^0-9]', '', 'g') AS from_phone`),
      this.db.raw(`${normalizedToPhoneSQL} AS to_phone`),

      this.db.raw(`
        CASE 
          WHEN type = 'template' THEN content->'template'->>'name'
          WHEN type = 'text' THEN content->'text'->>'body'
          ELSE content::text
        END AS "lastMessageContent"
      `),

      'created_at',
      'updated_at',
    ])
    .where('phone_number_id', phone_number_id)
    .andWhere('user_id', userId)

    // ✅ unique per CLEAN number
    .distinctOn([this.db.raw(normalizedToPhoneSQL) as any])

    // ⚠️ must match DISTINCT ON
    .orderByRaw(`${normalizedToPhoneSQL}, created_at DESC`)
    .as('lm');

  // 🔹 Subquery: total messages per number
  const counts = this.query()
    .select([
      this.db.raw(`${normalizedToPhoneSQL} AS to_phone`),
      this.db.raw(`COUNT(*) AS "totalMessages"`),
    ])
    .where('phone_number_id', phone_number_id)
    .andWhere('user_id', userId)
    .groupByRaw(normalizedToPhoneSQL)
    .as('counts');

  // 🔹 Final Query
  return query
    .select([
      'lm.phone_number_id',
      'lm.direction',
      'lm.lastMessageType',
      'lm.lastMessageStatus',
      'lm.from_phone',
      'lm.to_phone',
      'lm.lastMessageContent',
      'lm.created_at',
      'lm.updated_at',
      'counts.totalMessages',
    ])
    .from(lastMessages)
    .join(counts, 'lm.to_phone', 'counts.to_phone')
    .orderBy('lm.created_at', 'desc');
}

async getLeadConversations(
  contactNumber: string,
  phone_number_id: string,
  userId:string
) {
  const query = this.query();

  // 🔥 normalize to last 10 digits
  const normalizedNumber = contactNumber.slice(-10);

  const result = await query
    .select([
      'id',
      'phone_number_id',
      'direction',
      'type',

      // 🔥 remove '+' from numbers (for response)
      this.db.raw(`REPLACE(from_phone, '+', '') AS from_phone`),
      this.db.raw(`REPLACE(to_phone, '+', '') AS to_phone`),

      'status',
      'created_at',

      // 🔥 FIXED: return TEXT only (no json/text conflict)
      this.db.raw(`
        CASE 
          WHEN type = 'text' 
            THEN content->'text'->>'body'
        END AS "content"
      `),

      // 🔥 keep template JSON separately
      this.db.raw(`
        CASE 
          WHEN type = 'template' 
            THEN content->'template'->'components'
          ELSE NULL
        END AS "templateComponents"
      `),
    ])
    .where('phone_number_id', phone_number_id)
    .andWhere('user_id', userId)
    .andWhere((builder) => {
      builder
        .whereRaw(
          `RIGHT(REPLACE(from_phone, '+', ''), 10) = ?`,
          [normalizedNumber]
        )
        .orWhereRaw(
          `RIGHT(REPLACE(to_phone, '+', ''), 10) = ?`,
          [normalizedNumber]
        );
    })
    .orderBy('created_at', 'desc')
    .limit(20);

  // 🔥 reverse for chat UI (old → new)
  return result.reverse();
}
}

export default new MessageModel();
