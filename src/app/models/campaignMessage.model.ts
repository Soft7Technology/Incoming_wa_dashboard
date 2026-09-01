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

  async getPendingMessages(
    campaignId: string,
    limit: number,
    status?: string,
    errorMessage?: string
  ) {
    console.log("Status",status,errorMessage)
    const query = this.query()
      .where("campaign_id", campaignId)
      .where("status", status || "pending")
      .limit(limit);

    // if (errorMessage) {
    //   query.andWhere((qb) => {
    //     qb.where("error_message", errorMessage)
    //       .orWhereNull("error_message");
    //   });
    // }

    return query;
  }

  async getFailedMessages(
  campaignId: string,
  BATCH_SIZE:any,
) {
  return this.query()
    .join("messages", "messages.id", "campaign_messages.message_id")
    .where("campaign_messages.campaign_id", campaignId)
    .where((qb) => {
      qb.where("campaign_messages.status", "failed")
        .orWhere("messages.status", "failed");
    })
    .select(
      "campaign_messages.*",
      "messages.status as message_status"
    )
    .limit(BATCH_SIZE);
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

  //   SELECT 
  //   COALESCE(cm.error_message,m.error_message) AS error_message,
  //   COUNT(*) AS total
  // FROM campaign_messages cm
  // LEFT JOIN messages m
  //   ON m.id = cm.message_id
  // WHERE cm.campaign_id = 'f9f2cf60-e5cd-4da3-9350-c064396aa8fe'
  //  AND (
  //    cm.status = 'failed'
  //    OR m.status = 'failed'
  //  )
  // GROUP BY COALESCE(cm.error_message,m.error_message)
  // ORDER BY total DESC


  async failureMessageStats(campaignId: string) {
    return this.query()
      .from('campaign_messages as cm')
      .leftJoin('messages as m', 'm.id', 'cm.message_id')
      .where('cm.campaign_id', campaignId)
      .whereRaw(`( m.status = \'failed\')`)
      .select(
        this.db.raw(`COALESCE(m.error_message, cm.error_message, m.error_code::text) AS error_message`),
        this.db.raw(`COUNT(*) AS total`)
      )
      .groupBy(
        this.db.raw(`COALESCE(m.error_message, cm.error_message, m.error_code::text)`)
      )
      .orderBy('total', 'desc')
  }


  async getCampaignStats(campaignId: string) {
    return this.query()
      .from('campaign_messages as cm')
      .leftJoin('messages as m', 'm.id', 'cm.message_id')
      .where('cm.campaign_id', campaignId)
      .select(
        this.db.raw(`COUNT(*) FILTER (WHERE m.status = 'sent')     AS sent_count`),
        this.db.raw(`COUNT(*) FILTER (WHERE cm.status = 'pending')  AS pending_count`),
        this.db.raw(`COUNT(*) FILTER (WHERE m.status = 'delivered') AS delivered_count`),
        this.db.raw(`COUNT(*) FILTER (WHERE m.status = 'read')    AS read_count`),
        this.db.raw(`COUNT(*) FILTER (WHERE m.status = 'failed' OR cm.status = 'failed')  AS failed_count`),
        this.db.raw(`
           COUNT(*) FILTER(
             WHERE cm.status = 'failed' OR m.status = 'failed'
           ) AS failed_count
          `),
        this.db.raw(`ROUND(COALESCE(SUM(m.cost), 0),1) AS total_cost`),
      )
      .first();
  }


  // async getCampaignMessageStatus(
  //   campaignId: string,
  //   status?: string,
  //   page: number = 1,
  //   pageSize: number = 10
  // ) {
  //   const offset = (page - 1) * pageSize;

  //   console.log("Details", campaignId, status, page, pageSize)

  //   // ---------- BASE QUERY ----------
  //   const baseQuery = this.query()
  //     .from('campaign_messages as cm')
  //     .leftJoin('messages as m', 'm.id', 'cm.message_id')
  //     .join('contacts as c', 'c.id', 'cm.contact_id')
  //     .join('campaigns as ca', 'ca.id', 'cm.campaign_id')
  //     .join('templates as t', 't.id', 'ca.template_id')
  //     .where('cm.campaign_id', campaignId);

  //   if (status) {
  //     baseQuery.andWhereRaw(
  //       `COALESCE(m.status, cm.status) = ?`,
  //       [status]
  //     );
  //   }

  //   // ---------- TOTAL COUNT ----------
  //   const [{ count }] = await baseQuery
  //     .clone()
  //     .clearSelect()
  //     .count('* as count');

  //   const total = Number(count);

  //   // ---------- PAGINATED DATA ----------
  //   const data = await baseQuery
  //     .clone()
  //     .select(
  //       this.db.raw(`c.attributes ->> 'fullName' AS "leadName"`),
  //       this.db.raw(`REPLACE(c.phone_number, '+', '') AS "phoneNumber"`),
  //       'm.status as messageStatus',
  //       'm.from_phone as fromPhone',
  //       'm.to_phone as toPhone',
  //       't.name as templateName',
  //       'cm.template_variables as templateVariables',
  //       'm.cost as messageCost',
  //       'm.error_message as messageError',
  //       'cm.error_message as campaignError',
  //       'm.error_code as messageErrorCode',
  //       'm.read_at as readAt',
  //       'm.delivered_at as deliveredAt',
  //       'm.failed_at as failedAt',
  //       'm.created_at as sentAt'
  //     )
  //     .limit(pageSize)
  //     .offset(offset)

  //   // ---------- PAGINATION META ----------
  //   const totalPages = Math.ceil(total / pageSize);

  //   return {
  //     data,
  //     pagination: {
  //       page,
  //       pageSize,
  //       total,
  //       totalPages,
  //       hasNextPage: page < totalPages,
  //       hasPreviousPage: page > 1
  //     }
  //   };
  // }



  async getCampaignMessageStatus(
    campaignId: string,
    status?: string,
    page: number = 1,
    pageSize: number = 10
  ) {
    const offset = (page - 1) * pageSize;

    const effectiveStatusSql = `
    CASE
      WHEN cm.status::text = 'failed' OR m.status::text = 'failed'
        THEN 'failed'
      WHEN m.status IS NOT NULL
        THEN m.status::text
      ELSE cm.status::text
    END
  `;

    const baseQuery = this.query()
      .from('campaign_messages as cm')
      .leftJoin('messages as m', 'm.id', 'cm.message_id')
      .join('contacts as c', 'c.id', 'cm.contact_id')
      .join('campaigns as ca', 'ca.id', 'cm.campaign_id')
      .join('templates as t', 't.id', 'ca.template_id')
      .where('cm.campaign_id', campaignId);

    // Filtering:
    // status=failed finds failures from campaign_messages OR messages.
    // Other statuses use the final/effective status.
    if (status === 'failed') {
      baseQuery.andWhere((query) => {
        query
          .where('cm.status', 'failed')
          .orWhere('m.status', 'failed');
      });
    } else if (status) {
      baseQuery.andWhereRaw(`${effectiveStatusSql} = ?`, [status]);
    }

    const totalResult = await baseQuery
      .clone()
      .clearSelect()
      .count('* as count')
      .first();

    const total = Number(totalResult?.count || 0);

    const data = await baseQuery
      .clone()
      .select(
        'cm.id as campaignMessageId',
        'cm.campaign_id as campaignId',
        'cm.contact_id as contactId',
        'cm.message_id as messageId',

        this.db.raw(`c.attributes ->> 'fullName' AS "leadName"`),
        this.db.raw(`REPLACE(c.phone_number, '+', '') AS "phoneNumber"`),

        // Helpful for debugging: see each table's actual status.
        this.db.raw(`cm.status::text AS "campaignMessageStatus"`),
        this.db.raw(`m.status::text AS "messageStatus"`),

        // Final status returned to frontend.
        this.db.raw(`${effectiveStatusSql} AS "status"`),

        'm.from_phone as fromPhone',
        'm.to_phone as toPhone',
        't.name as templateName',
        'cm.template_variables as templateVariables',
        'm.cost as messageCost',

        // Error can be stored in either table.
        this.db.raw(`
        COALESCE(m.error_message, cm.error_message) AS "errorMessage"
      `),
        this.db.raw(`
        COALESCE(m.error_code::text, cm.error_code) AS "errorCode"
      `),

        'cm.error_message as campaignErrorMessage',
        'cm.error_code as campaignErrorCode',
        'm.error_message as messageErrorMessage',
        'm.error_code as messageErrorCode',

        'cm.failed_at as campaignFailedAt',
        'm.failed_at as messageFailedAt',
        'cm.sent_at as campaignSentAt',
        'm.created_at as sentAt',
        'm.delivered_at as deliveredAt',
        'm.read_at as readAt'
      )
      .orderBy('cm.created_at', 'desc')
      .limit(pageSize)
      .offset(offset);

    const totalPages = Math.ceil(total / pageSize);

    return {
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }



  async failureMessageInfo(
    campaignId: string,
    error: string,
    page: number = 1,
    pageSize: number = 10
  ) {
    const offset = (page - 1) * pageSize;

    const columns = [
      this.db.raw(`c.attributes ->> 'fullName' AS "leadName"`),
      this.db.raw(`REPLACE(c.phone_number, '+', '') AS "phoneNumber"`),
      this.db.raw(`m.from_phone AS "phone"`),
      this.db.raw(`m.status AS "messageStatus"`),
      this.db.raw(`m.error_message AS "messageError"`),
      this.db.raw(`m.error_code AS "messageErrorCode"`),
      this.db.raw(`cm.error_message AS "campaignError"`),
      this.db.raw(`m.created_at AS "createdAt"`)
    ];

    const campaignFailures = this.query()
      .from('campaign_messages as cm')
      .leftJoin('messages as m', 'm.id', 'cm.message_id')
      .join('contacts as c', 'c.id', 'cm.contact_id')
      .where('cm.campaign_id', campaignId)
      .where('cm.status', 'failed')
      .where('cm.error_message', error)
      .select(columns);

    const messageFailures = this.query()
      .from('campaign_messages as cm')
      .join('messages as m', 'm.id', 'cm.message_id')
      .join('contacts as c', 'c.id', 'cm.contact_id')
      .where('cm.campaign_id', campaignId)
      .where('m.status', 'failed')
      .where('m.error_message', error)
      .select(columns);

    // -----------------------------
    // UNION QUERY
    // -----------------------------
    const unionQuery = this.db
      .unionAll([campaignFailures, messageFailures], true)
      .as('failures');

    // -----------------------------
    // TOTAL COUNT
    // -----------------------------
    const [{ total }] = await this.db
      .from(unionQuery)
      .count('* as total');

    // -----------------------------
    // PAGINATED DATA
    // -----------------------------
    const data = await this.db
      .from(unionQuery)
      .select('*')
      .orderBy('createdAt', 'desc')
      .limit(pageSize)
      .offset(offset);

    const totalNumber = Number(total);
    const totalPages = Math.ceil(totalNumber / pageSize);

    return {
      data,
      pagination: {
        page,
        pageSize,
        total: totalNumber,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    };
  }



  async buttonClickRateInfo(
    campaignId: string,
    page: number = 1,
    pageSize: number = 10
  ) {
    const offset = (page - 1) * pageSize;

    console.log("Details", campaignId, page, pageSize)

    const baseQuery = this.query()
      .from('campaign_messages as cm')
      .join('messages as parent', 'parent.id', 'cm.message_id')
      .join('messages as child', 'child.context', 'parent.wamid')
      .where('cm.campaign_id', campaignId)
      .select(
        this.db.raw(`child.from_phone AS "fromPhone"`),
        this.db.raw(`child.type AS "messageType"`),
        this.db.raw(`child.profile_name AS "leadName"`)
      )
      .limit(pageSize)
      .offset(offset)

    // ---------- DATA ----------
    const data = await baseQuery;

    // ---------- TOTAL COUNT ----------
    const [{ count }] = await this.query()
      .from('campaign_messages as cm')
      .join('messages as parent', 'parent.id', 'cm.message_id')
      .join('messages as child', 'child.context', 'parent.wamid')
      .where('cm.campaign_id', campaignId)
      .count('* as count');

    const total = Number(count);
    const totalPages = Math.ceil(total / pageSize)

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