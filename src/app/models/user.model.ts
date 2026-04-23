import { BaseModel } from '@surefy/models/base.model';

class UserModel extends BaseModel {
  constructor() {
    super('users');
  }

  async findByEmail(email: any) {
    return this.query().where({ email }).whereNull('deleted_at').first();
  }

  // async getNotificationStats(userId: string) {
  //   return this.query()
  //     .select(
  //       this.query()
  // }

  async getUserStats(userId: string) {
    return this.query()
      .select(
        // campaigns
        this.query().from('campaigns').count('*').where('user_id', userId).as('campaigns_count'),

        //Chatbot
        this.query().from("chat_bot").count("*").where("user_id",userId).as('chatbot_count'),

        // contact_lists
        this.query().from('contacts').count('*').where('user_id', userId).as('contacts_count'),

        // contact_lists
        this.query().from('contact_lists').count('*').where('user_id', userId).as('contact_lists_count'),

        // messages - SENT
        this.query().from('messages').count('*').where('user_id', userId).andWhere('status', 'sent').as('sent_count'),

        // messages - FAILED
        this.query()
          .from('messages')
          .count('*')
          .where('user_id', userId)
          .andWhere('status', 'failed')
          .as('failed_count'),

        // messages - DELIVERED
        this.query()
          .from('messages')
          .count('*')
          .where('user_id', userId)
          .andWhere('status', 'delivered')
          .as('delivered_count'),

        this.query().from('messages').count('*').where('user_id', userId).as('total_count'),

        // messages - RECEIVED
        this.query()
          .from('messages')
          .count('*')
          .where('user_id', userId)
          .andWhere('status', 'received')
          .as('received_count'),

        // messages - DELIVERED
        this.query().from('messages').count('*').where('user_id', userId).andWhere('status', 'sent').as('sent_count'),

        // messages - SENT
        this.query()
          .from('messages')
          .count('*')
          .where('user_id', userId)
          .andWhere('type', 'template')
          .as('message_template_count'),

        this.query().from('messages').countDistinct('to_phone').where('user_id', userId).as('unique_contacts_count'),

        // templates
        this.query()
          .from('templates')
          .count('*')
          .where('user_id', (qb: any) => {
            qb.select('user_id').from('users').where('user_id', userId).limit(1);
          })
          .as('templates_count'),
      )
      .first()
      .then((res: any) => ({
        ...res,
        total_messages: Number(res.sent_count) + Number(res.failed_count) + Number(res.delivered_count),
      }));
  }

  async findByPhone(phone: string) {
    return this.query().where({ phone }).whereNull('deleted_at').first();
  }

  async findByEmailOrPhone(identifier: string) {
    return this.query()
      .where((builder) => {
        builder.where({ email: identifier }).orWhere({ phone: identifier });
      })
      .whereNull('deleted_at')
      .first();
  }

  async findByRole(role: string, filters: any = {}) {
    let query = this.query().where({ role }).whereNull('deleted_at');

    if (filters.status) {
      query = query.where({ status: filters.status });
    }

    if (filters.company_id) {
      query = query.where({ company_id: filters.company_id });
    }

    return query.orderBy('created_at', 'desc');
  }

  async updateLastLogin(userId: string, ipAddress: string) {
    return this.update(userId, {
      last_login_at: new Date(),
      last_login_ip: ipAddress,
    });
  }

  async changePassword(userId: string, hashedPassword: string) {
    return this.update(userId, {
      password: hashedPassword,
    });
  }

  async softDelete(userId: string) {
    return this.update(userId, {
      deleted_at: new Date(),
      status: 'inactive',
    });
  }

  async findAllUserByCompanyId(companyId: string,userRole?:string) {
    return this.query().where({ company_id: companyId,role:userRole }).whereNull('deleted_at').orderBy('created_at', 'desc');
  }

  async createUser(data: any) {
    const { name, email, phone, password, role, company_id } = data;

    let permissions: string[] = [];

    // Normalize input
    if (data.permissions) {
      if (Array.isArray(data.permissions)) {
        permissions = data.permissions;
      } else if (typeof data.permissions === 'string') {
        try {
          permissions = JSON.parse(data.permissions);
        } catch {
          permissions = [data.permissions];
        }
      }
    }

    // Convert to Postgres array format
    const pgArray = `{${permissions.join(',')}}`;

    return this.query()
      .insert({
        name,
        email,
        phone,
        password,
        role,
        company_id,
        permissions: pgArray, // ✅ works without knex.raw
      })
      .returning('*')
      .then((res: any) => res[0]);
  }

  async updateUser(userId: string, data: any) {
    const updateData: any = {};

    // Basic fields
    if (data.name) updateData.name = data.name;
    if (data.email) updateData.email = data.email;
    if (data.phone) updateData.phone = data.phone;
    if (data.role) updateData.role = data.role;

    // Handle permissions
    if (data.permissions) {
      let permissions: string[] = [];

      if (Array.isArray(data.permissions)) {
        permissions = data.permissions;
      } else if (typeof data.permissions === 'string') {
        try {
          permissions = JSON.parse(data.permissions);
        } catch {
          permissions = [data.permissions];
        }
      }

      // Convert to Postgres array format
      updateData.permissions = `{${permissions.map((p) => `"${p}"`).join(',')}}`;
    }

    return this.query()
      .where({ id: userId })
      .update(updateData)
      .returning('*')
      .then((res: any) => res[0]);
  }
}

export default new UserModel();
