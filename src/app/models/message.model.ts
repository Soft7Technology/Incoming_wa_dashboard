import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { buildRecipient, parseWhatsAppPhone } from '../utils/importPhone';
import { BaseModel } from '@surefy/models/base.model';

class MessageModel extends BaseModel {
  constructor() {
    super('messages');
  }

  /** Commit the outbound row before Meta; even an uncertain outcome blocks a resend. */
  async createOutbound(data: {
    company_id?: string; campaign_id?: string | null; phone_number_id: string;
    to_phone: string; [key: string]: unknown;
  }) {
    if (!data.campaign_id) return this.create(data);
    const recipient = data.to_phone.replace(/[^0-9]/g, '');
    return this.db.transaction(async trx => {
      // Serialize competing callers across API and worker processes, using existing history.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [
        `${data.company_id}:${data.phone_number_id}`, recipient,
      ]);
      if (data.campaign_id) {
        const existing = await trx('messages').where({
          company_id: data.company_id, campaign_id: data.campaign_id,
          phone_number_id: data.phone_number_id, direction: 'outbound',
        }).whereRaw("regexp_replace(to_phone, '[^0-9]', '', 'g') = ?", [recipient]).first('id');
        if (existing) {
          throw Object.assign(new HTTP400Error({ message: 'This campaign already sent or attempted this recipient. Resending is disabled.' }), {
            code: 'CAMPAIGN_MESSAGE_EXISTS',
          });
        }
      }
      return this.create(data, trx);
    }, { isolationLevel: 'read committed' });
  }

  /** One lookup for the current contact page; never match national-number suffixes. */
  async findLatestForContacts(contacts: any[]): Promise<{
    contact_id: string; last_message: any; read_count: string | number; unread_count: string | number;
  }[]> {
    const identities = contacts.flatMap(contact => {
      if (!contact.user_id || !contact.company_id || !contact.phone_number_id) return [];
      try {
        return [{
          contact_id: contact.id,
          user_id: contact.user_id,
          company_id: contact.company_id,
          phone_number_id: contact.phone_number_id,
          recipient: buildRecipient(contact.phone_number, contact.country_code),
        }];
      } catch {
        // Unresolved legacy numbers cannot safely identify a conversation.
        return [];
      }
    });
    if (!identities.length) return [];

    const result = await this.db.raw(`
      SELECT c.contact_id, latest.last_message, counts.read_count, counts.unread_count
      FROM jsonb_to_recordset(?::jsonb) AS c(
        contact_id text, user_id uuid, company_id uuid, phone_number_id uuid, recipient text
      )
      LEFT JOIN LATERAL (
        SELECT to_jsonb(m) AS last_message
        FROM messages m
        WHERE m.user_id = c.user_id
          AND m.company_id = c.company_id
          AND m.phone_number_id = c.phone_number_id
          AND CASE WHEN m.direction = 'inbound'
            THEN regexp_replace(m.from_phone, '[^0-9]', '', 'g')
            ELSE regexp_replace(m.to_phone, '[^0-9]', '', 'g') END = c.recipient
        ORDER BY m.created_at DESC NULLS LAST, m.id DESC
        LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE m.inbox_read_at IS NOT NULL OR m.status = 'read' OR m.read_at IS NOT NULL) AS read_count,
          COUNT(*) FILTER (WHERE m.inbox_read_at IS NULL AND m.status IS DISTINCT FROM 'read' AND m.read_at IS NULL) AS unread_count
        FROM messages m
        WHERE m.user_id = c.user_id
          AND m.company_id = c.company_id
          AND m.phone_number_id = c.phone_number_id
          AND m.direction = 'inbound'
          AND m.status IS DISTINCT FROM 'deleted'
          AND CASE WHEN m.direction = 'inbound'
            THEN regexp_replace(m.from_phone, '[^0-9]', '', 'g')
            ELSE regexp_replace(m.to_phone, '[^0-9]', '', 'g') END = c.recipient
      ) counts ON TRUE
    `, [JSON.stringify(identities)]);
    return result.rows;
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



  async findForInboxRead(scope: { user_id: string; company_id: string; phone_number_id: string },
    target: { identifier?: string; recipient?: string }) {
    const query = this.query().where(scope);
    if (target.identifier) {
      query.where(builder => {
        builder.where('wamid', target.identifier);
        if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(target.identifier!)) {
          builder.orWhere('id', target.identifier);
        }
      });
    } else if (target.recipient) {
      query.whereRaw(`CASE WHEN direction = 'inbound'
        THEN regexp_replace(from_phone, '[^0-9]', '', 'g')
        ELSE regexp_replace(to_phone, '[^0-9]', '', 'g') END = ?`, [target.recipient]);
    } else {
      throw new HTTP400Error({ message: 'Message identifier or recipient is required' });
    }
    return query.orderBy('created_at', 'desc', 'last').orderBy('id', 'desc').first();
  }

  async markInboxReadThrough(message: any) {
    const recipient = String(message.direction === 'inbound' ? message.from_phone : message.to_phone).replace(/\D/g, '');
    if (!recipient || !message.user_id || !message.company_id || !message.phone_number_id || !message.id) {
      throw new HTTP400Error({ message: 'A scoped conversation message is required' });
    }
    return this.query().where({
      user_id: message.user_id, company_id: message.company_id, phone_number_id: message.phone_number_id,
    }).whereRaw(`CASE WHEN direction = 'inbound'
      THEN regexp_replace(from_phone, '[^0-9]', '', 'g')
      ELSE regexp_replace(to_phone, '[^0-9]', '', 'g') END = ?`, [recipient])
      // Read the cutoff from the database to preserve PostgreSQL microseconds.
      // A new message arriving after this snapshot must remain unread.
      .whereRaw(`(COALESCE(created_at, '0001-01-01'), id) <=
        (SELECT COALESCE(created_at, '0001-01-01'), id FROM messages WHERE id = ?)`, [message.id])
      .whereNull('inbox_read_at')
      .update({ inbox_read_at: new Date() }).returning('id');
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

  async getLeadConversations(leadNumber: string, phone_number_id: string, userId: string) {
    const db = this.db;
    const normalizedNumber = leadNumber.replace(/\D/g, '');
    const isUuid = (val: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

    const targetPhoneIds: string[] = [];
    if (phone_number_id) {
      const strId = String(phone_number_id).trim();
      const isUuidStr = isUuid(strId);

      const pn = await db('phone_numbers')
        .where('phone_number_id', strId)
        .orWhere('display_phone_number', strId)
        .orWhere((builder) => {
          if (isUuidStr) builder.where('id', strId);
        })
        .first();

      if (pn) {
        if (pn.id) targetPhoneIds.push(String(pn.id));
      } else if (isUuidStr) {
        targetPhoneIds.push(strId);
      }
    }
    const validUuidIds = Array.from(new Set(targetPhoneIds.filter((id) => isUuid(id))));

    const result: any[] = await this.query()
      .from('messages')
      // A template name can exist in several WABAs. Never multiply message rows.
      .joinRaw(`LEFT JOIN LATERAL (
        SELECT template.components FROM templates AS template
        WHERE template.company_id = messages.company_id
          AND (template.id = messages.template_id OR (
            messages.template_id IS NULL AND template.user_id = messages.user_id
            AND template.name = messages.content->'template'->>'name'
            AND template.language = messages.content->'template'->'language'->>'code'
            AND template.waba_id = (SELECT waba_id FROM phone_numbers WHERE id = messages.phone_number_id)
          ))
        ORDER BY template.id LIMIT 1
      ) AS t ON true`)
      .select([
        'messages.id',
        'messages.phone_number_id',
        'messages.direction',
        'messages.type',

        db.raw(`REPLACE(messages.from_phone, '+', '') AS from_phone`),
        db.raw(`REPLACE(messages.to_phone, '+', '') AS to_phone`),

        'messages.status',
        'messages.wamid',
        'messages.read_at',
        'messages.inbox_read_at',
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
      .where((builder) => {
        if (validUuidIds.length > 0) {
          builder.whereRaw(`"messages"."phone_number_id"::text IN (${validUuidIds.map(() => '?').join(', ')})`, validUuidIds);
        }
      })
      .andWhere((builder) => {
        const internationalNumber = normalizedNumber.replace(/\D/g, '');
        builder
          .whereRaw(
            `REGEXP_REPLACE(messages.from_phone, '[^0-9]', '', 'g') = ?`,
            [internationalNumber]
          )
          .orWhereRaw(
            `REGEXP_REPLACE(messages.to_phone, '[^0-9]', '', 'g') = ?`,
            [internationalNumber]
          );
      })
      .orderBy('messages.created_at', 'desc')
      .limit(20);

    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const recentInboundMessage = result.find((msg) => {
      const messageTime = new Date(msg.created_at).getTime();

      return (
        msg.direction === 'inbound' ||
        (msg.type === 'template' &&
        now - messageTime <= TWENTY_FOUR_HOURS)
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
    const isUuid = (val: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

    const targetPhoneIds: string[] = [];
    if (phone_number_id) {
      const strId = String(phone_number_id).trim();
      const isUuidStr = isUuid(strId);

      const pn = await db('phone_numbers')
        .where('phone_number_id', strId)
        .orWhere('display_phone_number', strId)
        .orWhere((builder) => {
          if (isUuidStr) builder.where('id', strId);
        })
        .first();

      if (pn) {
        if (pn.id) targetPhoneIds.push(String(pn.id));
      } else if (isUuidStr) {
        targetPhoneIds.push(strId);
      }
    }
    const validUuidIds = Array.from(new Set(targetPhoneIds.filter((id) => isUuid(id))));

    const contactPhoneSQL = `
      CASE WHEN direction = 'inbound' THEN REGEXP_REPLACE(from_phone, '[^0-9]', '', 'g')
        ELSE REGEXP_REPLACE(to_phone, '[^0-9]', '', 'g') END
    `.trim();

    // 🔹 Subquery: latest message per unique contact phone
    const lastMessages = this.query()
      .select([
        'phone_number_id',
        'direction',

        this.db.raw(`type AS "lastMessageType"`),
        this.db.raw(`status AS "lastMessageStatus"`),

        // normalize phones
        this.db.raw(`REGEXP_REPLACE(from_phone, '[^0-9]', '', 'g') AS from_phone`),
        this.db.raw(`REGEXP_REPLACE(to_phone, '[^0-9]', '', 'g') AS to_phone`),
        this.db.raw(`${contactPhoneSQL} AS contact_phone`),

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
      .where((builder: any) => {
        if (validUuidIds.length > 0) {
          builder.whereIn(db.raw('"phone_number_id"::text'), validUuidIds);
        }
      })
      .where((builder: any) => {
        builder
          .where('user_id', userId)
          .orWhereIn(
            db.raw(contactPhoneSQL),
            db('contacts')
              .select(db.raw(`regexp_replace(phone_number, '[^0-9]', '', 'g')`))
              .whereRaw('assigned_to @> ARRAY[?]::uuid[]', [userId])
              .whereNull('deleted_at')
          );
      })

      // ✅ unique per CLEAN contact number
      .distinctOn([this.db.raw(contactPhoneSQL) as any])

      // ⚠️ must match DISTINCT ON
      .orderByRaw(`${contactPhoneSQL}, created_at DESC`)
      .as('lm');

    // 🔹 Subquery: total messages per contact number
    const counts = this.query()
      .select([this.db.raw(`${contactPhoneSQL} AS contact_phone`), this.db.raw(`COUNT(*) AS "totalMessages"`)])
      .where((builder: any) => {
        if (validUuidIds.length > 0) {
          builder.whereIn(db.raw('"phone_number_id"::text'), validUuidIds);
        }
      })
      .where((builder: any) => {
        builder
          .where('user_id', userId)
          .orWhereIn(
            db.raw(contactPhoneSQL),
            db('contacts')
              .select(db.raw(`regexp_replace(phone_number, '[^0-9]', '', 'g')`))
              .whereRaw('assigned_to @> ARRAY[?]::uuid[]', [userId])
              .whereNull('deleted_at')
          );
      })
      .groupByRaw(contactPhoneSQL)
      .as('counts');

    // 🔹 Final Query
    return this.query()
      .select([
        'lm.phone_number_id',
        'lm.direction',
        'lm.lastMessageType',
        'lm.lastMessageStatus',
        'lm.from_phone',
        'lm.to_phone',
        'lm.contact_phone',
        'lm.lastMessageContent',
        'lm.created_at',
        'lm.updated_at',
        'counts.totalMessages',
      ])
      .from(lastMessages)
      .join(counts, 'lm.contact_phone', 'counts.contact_phone')
      .orderBy('lm.created_at', 'desc');
  }

  /** Fetch at most ten usable messages for one customer on one business number. */
  async getRecentMessages(userId: string, companyId: string, phoneNumberId: string, phone: string, limit = 10) {
    if (!userId || !companyId || !phoneNumberId) throw new Error('Message history requires account and sending-number scope');
    const identity = parseWhatsAppPhone(phone);
    // Compare the complete international identity to avoid matching another country.
    const recipient = identity.country_code + identity.phone_number;
    return this.query()
      .where({ user_id: userId, company_id: companyId, phone_number_id: phoneNumberId })
      // Queued/failed messages were not successfully exchanged and are not AI context.
      .whereIn('status', ['received', 'sent', 'delivered', 'read'])
      .andWhere(builder => {
        builder.where(q => q.where('direction', 'inbound')
          .whereRaw("REGEXP_REPLACE(from_phone, '[^0-9]', '', 'g') = ?", [recipient]))
          .orWhere(q => q.where('direction', 'outbound')
            .whereRaw("REGEXP_REPLACE(to_phone, '[^0-9]', '', 'g') = ?", [recipient]));
      })
      .orderBy('created_at', 'desc').orderBy('id', 'desc')
      .limit(Math.max(1, Math.min(10, limit)));
  }
}

export default new MessageModel();
