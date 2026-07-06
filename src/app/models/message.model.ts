import { BaseModel } from '@surefy/models/base.model';

class MessageModel extends BaseModel {
  constructor() {
    super('messages');
  }

  async getUserDashboard(companyId: string, userId: string) {
    const query = this.db('users as u') // use knex instance properly
      .where({
        'u.id': userId,
        'u.company_id': companyId,
      })

      // Campaign count
      .leftJoin(
        this.db('campaigns').select('user_id').count('* as total_campaigns').groupBy('user_id', userId).as('cc'),
        'cc.user_id',
        'u.id',
      )

      // Contacts count
      .leftJoin(
        this.db('contacts').select('user_id').count('* as active_contacts').groupBy('user_id', userId).as('ct'),
        'ct.user_id',
        'u.id',
      )

      // Leads count
      .leftJoin(
        this.db('contact_lists').select('user_id').count('* as total_leads').groupBy('user_id', userId).as('lc'),
        'lc.user_id',
        'u.id',
      )

      // Messages count
      .leftJoin(
        this.db('messages')
          .select('user_id')
          .sum({
            messages_sent: this.db.raw("CASE WHEN direction = 'sent' THEN 1 ELSE 0 END"),
          })
          .sum({
            messages_received: this.db.raw("CASE WHEN direction = 'received' THEN 1 ELSE 0 END"),
          })
          .groupBy('user_id', userId)
          .as('mc'),
        'mc.user_id',
        'u.id',
      )

      // Campaigns + Plan
      .leftJoin('campaigns as c', 'c.user_id', 'u.id')
      .leftJoin('subscription_plans as p', 'p.id', 'u.plan_id')

      .select(
        'u.id',
        'u.name',

        this.db.raw('COALESCE(lc.total_leads, 0) as total_leads'),
        this.db.raw('COALESCE(mc.messages_sent, 0) as messages_sent'),
        this.db.raw('COALESCE(mc.messages_received, 0) as messages_received'),
        this.db.raw('COALESCE(cc.total_campaigns, 0) as total_campaigns'),
        this.db.raw('COALESCE(ct.active_contacts, 0) as active_contacts'),

        this.db.raw(`
        COALESCE(
          json_agg(DISTINCT c.*) FILTER (WHERE c.id IS NOT NULL),
          '[]'
        ) as campaigns
      `),

        'p.id as plan_id',
        'p.plan_name',
        'p.price',
        'p.billing_cycle',
        'p.features',
      )

      .groupBy(
        'u.id',
        'p.id',
        'cc.total_campaigns',
        'ct.active_contacts',
        'lc.total_leads',
        'mc.messages_sent',
        'mc.messages_received',
      )
      .first();

    return query;
  }

  async findByCompanyId(companyId: string, userId: string, filters: any = {}) {
    let query = this.query().where({ company_id: companyId });

    if (filters.status) {
      query.where({ status: filters.status });
    }

    if (filters.userId) {
      query.where({ user_id: filters.userId });
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

  async findByUserId(companyId: string, userId: string, filters: any = {}) {
    let query = this.query().where({ company_id: companyId });

    if (filters.status) {
      query.where({ status: filters.status });
    }

    if (filters.userId) {
      query.where({ user_id: filters.userId });
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
      .select(
        this.db.raw(`
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN status = 'read' THEN 1 END) as read,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      `),
      );

    if (fromDate) {
      query.where('created_at', '>=', fromDate);
    }

    if (toDate) {
      query.where('created_at', '<=', toDate);
    }

    return query.first();
  }

  // async getMessagesConversation(userId: string, phone_number_id: string) {
  //   console.log("User Id",userId)
  //   const query = this.query();

  //   // ✅ FULL normalization (BEST)
  //   const normalizedToPhoneSQL = `REGEXP_REPLACE(to_phone, '[^0-9]', '', 'g')`;

  //   // 🔹 Subquery: latest message per unique phone
  //   const lastMessages = this.query()
  //     .select([
  //       'phone_number_id',
  //       'direction',

  //       this.db.raw(`type AS "lastMessageType"`),
  //       this.db.raw(`status AS "lastMessageStatus"`),

  //       // normalize phones
  //       this.db.raw(`REGEXP_REPLACE(from_phone, '[^0-9]', '', 'g') AS from_phone`),
  //       this.db.raw(`${normalizedToPhoneSQL} AS to_phone`),

  //       this.db.raw(`
  //         CASE
  //           WHEN type = 'template' THEN content->'template'->>'name'
  //           WHEN type = 'text' THEN content->'text'->>'body'
  //           ELSE content::text
  //         END AS "lastMessageContent"
  //       `),

  //       'created_at',
  //       'updated_at',
  //     ])
  //     .where('phone_number_id', phone_number_id)
  //     .andWhere('user_id', userId)

  //     // ✅ unique per CLEAN number
  //     .distinctOn([this.db.raw(normalizedToPhoneSQL) as any])

  //     // ⚠️ must match DISTINCT ON
  //     .orderByRaw(`${normalizedToPhoneSQL}, created_at DESC`)
  //     .as('lm');

  //   // 🔹 Subquery: total messages per number
  //   const counts = this.query()
  //     .select([
  //       this.db.raw(`${normalizedToPhoneSQL} AS to_phone`),
  //       this.db.raw(`COUNT(*) AS "totalMessages"`),
  //     ])
  //     .where('phone_number_id', phone_number_id)
  //     .andWhere('user_id', userId)
  //     .groupByRaw(normalizedToPhoneSQL)
  //     .as('counts');

  //   // 🔹 Final Query
  //   return query
  //     .select([
  //       'lm.phone_number_id',
  //       'lm.direction',
  //       'lm.lastMessageType',
  //       'lm.lastMessageStatus',
  //       'lm.from_phone',
  //       'lm.to_phone',
  //       'lm.lastMessageContent',
  //       'lm.created_at',
  //       'lm.updated_at',
  //       'counts.totalMessages',
  //     ])
  //     .from(lastMessages)
  //     .join(counts, 'lm.to_phone', 'counts.to_phone')
  //     .orderBy('lm.created_at', 'desc');
  // }

  // async getLeadConversations(contactNumber: string, phone_number_id: string, userId: string) {
  //   const db = this.db;
  //   const query = this.query();

  //   const normalizedNumber = contactNumber.slice(-10);

  //   const result = await query
  //     .leftJoin('templates as t', function () {
  //       this.on('t.id', '=', 'messages.template_id')
  //         .orOn((join) => {
  //           join.on('t.name', '=', db.raw(`content->'template'->>'name'`))
  //             .andOn('t.language', '=', db.raw(`content->'template'->'language'->>'code'`));
  //         });
  //     })
  //     .select([
  //       'messages.id',
  //       'messages.phone_number_id',
  //       'messages.direction',
  //       'messages.type',

  //       this.db.raw(`REPLACE(messages.from_phone, '+', '') AS from_phone`),
  //       this.db.raw(`REPLACE(messages.to_phone, '+', '') AS to_phone`),

  //       'messages.status',
  //       'messages.created_at',
  //       'messages.content',

  //       this.db.raw(`
  //         CASE
  //           WHEN messages.type = 'template'
  //             THEN COALESCE(
  //               NULLIF(messages.content->'template'->'components', '[]'::jsonb),
  //               t.components,
  //               '[]'::jsonb
  //             )
  //           ELSE NULL
  //         END AS "templateComponents"
  //       `),
  //     ])
  //     .where('phone_number_id', phone_number_id)
  //     .andWhere((builder) => {
  //       builder
  //         .whereRaw(`RIGHT(REPLACE(from_phone, '+', ''), 10) = ?`, [normalizedNumber])
  //         .orWhereRaw(`RIGHT(REPLACE(to_phone, '+', ''), 10) = ?`, [normalizedNumber]);
  //     })
  //     .orderBy('created_at', 'desc')
  //     .limit(20);

  //   const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  //   const now = Date.now();

  //   let isWindowOpen = false; // 🔥 default CLOSED

  //   if (result.length > 0) {
  //     // 🔥 find ANY template within last 24h
  //     const validTemplate = result.find((msg) => {
  //       if (msg.type !== 'template') return false;

  //       if(msg.direction === 'inbound') return true

  //       const templateTime = new Date(msg.created_at).getTime();
  //       return now - templateTime <= TWENTY_FOUR_HOURS;
  //     });

  //     if (validTemplate) {
  //       isWindowOpen = true; // ✅ OPEN only if template found in 24h
  //     }
  //   }

  //   return {
  //     isWindowOpen,
  //     messages: result.reverse(),
  //   };
  // }



  async getLeadConversations(
    contactNumber: string,
    phone_number_id: string,
    userId: string
  ) {
    const db = this.db;
    const query = this.query();

    const normalizedNumber = contactNumber.slice(-10);

    const result = await query
      .leftJoin('templates as t', function () {
        this.on('t.id', '=', 'messages.template_id')
          .orOn((join) => {
            join
              .on(
                't.name',
                '=',
                db.raw(`messages.content->'template'->>'name'`)
              )
              .andOn(
                't.language',
                '=',
                db.raw(`messages.content->'template'->'language'->>'code'`)
              );
          });
      })
      .select([
        'messages.id',
        'messages.phone_number_id',
        'messages.direction',
        'messages.type',

        db.raw(`REPLACE(messages.from_phone, '+', '') AS from_phone`),
        db.raw(`REPLACE(messages.to_phone, '+', '') AS to_phone`),

        'messages.status',
        'messages.created_at',
        'messages.content',

        db.raw(`
        CASE
          WHEN messages.type = 'template'
          THEN COALESCE(
            NULLIF(messages.content->'template'->'components', '[]'::jsonb),
            t.components,
            '[]'::jsonb
          )
          ELSE NULL
        END AS "templateComponents"
      `),
      ])
      .where('messages.phone_number_id', phone_number_id)
      .andWhere((builder) => {
        builder
          .whereRaw(
            `RIGHT(REPLACE(messages.from_phone, '+', ''), 10) = ?`,
            [normalizedNumber]
          )
          .orWhereRaw(
            `RIGHT(REPLACE(messages.to_phone, '+', ''), 10) = ?`,
            [normalizedNumber]
          );
      })
      .orderBy('messages.created_at', 'desc')
      .limit(20);

    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Open window if ANY inbound message from customer
    // exists within last 24 hours
    const recentInboundMessage = result.find((msg) => {
      const messageTime = new Date(msg.created_at).getTime();

      return (
        msg.direction === 'inbound' &&
        now - messageTime <= TWENTY_FOUR_HOURS
      );
    });

    const isWindowOpen = !!recentInboundMessage;

    return {
      isWindowOpen,
      messages: result.reverse(),
    };
  }

  async getMessagesConversation(userId: string, phone_number_id: string) {
    console.log('User Id', userId);
    const db = this.db;
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
      .where((builder: any) => {
        builder
          .where('user_id', userId)
          .orWhereIn(
            db.raw(`REGEXP_REPLACE(to_phone, '[^0-9]', '', 'g')`),
            db('contacts')
              .select(db.raw(`REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g')`))
              .whereRaw('assigned_to @> ARRAY[?]::uuid[]', [userId])
              .whereNull('deleted_at')
          );
      })

      // ✅ unique per CLEAN number
      .distinctOn([this.db.raw(normalizedToPhoneSQL) as any])

      // ⚠️ must match DISTINCT ON
      .orderByRaw(`${normalizedToPhoneSQL}, created_at DESC`)
      .as('lm');

    // 🔹 Subquery: total messages per number
    const counts = this.query()
      .select([this.db.raw(`${normalizedToPhoneSQL} AS to_phone`), this.db.raw(`COUNT(*) AS "totalMessages"`)])
      .where('phone_number_id', phone_number_id)
      .where((builder: any) => {
        builder
          .where('user_id', userId)
          .orWhereIn(
            db.raw(`REGEXP_REPLACE(to_phone, '[^0-9]', '', 'g')`),
            db('contacts')
              .select(db.raw(`REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g')`))
              .whereRaw('assigned_to @> ARRAY[?]::uuid[]', [userId])
              .whereNull('deleted_at')
          );
      })
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
}

export default new MessageModel();
