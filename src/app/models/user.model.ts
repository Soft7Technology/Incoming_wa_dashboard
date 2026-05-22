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

  async getUserStats(
    userId: string,
    time_frame: '7days' | '1month' | '6months' | '1year' | 'all' = 'all'
  ) {
    const now = new Date();

    let startDate: Date | null = null;

    switch (time_frame) {
      case '7days':
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;

      case '1month':
        startDate = new Date(now.setMonth(now.getMonth() - 1));
        break;

      case '6months':
        startDate = new Date(now.setMonth(now.getMonth() - 6));
        break;

      case '1year':
        startDate = new Date(now.setFullYear(now.getFullYear() - 1));
        break;

      default:
        startDate = null;
    }

    const applyDateFilter = (query: any) => {
      if (startDate) {
        query.andWhere('created_at', '>=', startDate);
      }

      return query;
    };

    return this.query()
      .select(
        // campaigns
        applyDateFilter(
          this.query()
            .from('campaigns')
            .count('*')
            .where('user_id', userId)
        ).as('campaigns_count'),

        // chatbot
        applyDateFilter(
          this.query()
            .from('chat_bot')
            .count('*')
            .where('user_id', userId)
        ).as('chatbot_count'),

        // contacts
        applyDateFilter(
          this.query()
            .from('contacts')
            .count('*')
            .where('user_id', userId)
        ).as('contacts_count'),

        // contact lists
        applyDateFilter(
          this.query()
            .from('contact_lists')
            .count('*')
            .where('user_id', userId)
        ).as('contact_lists_count'),

        // sent messages
        applyDateFilter(
          this.query()
            .from('messages')
            .count('*')
            .where('user_id', userId)
            .andWhere('status', 'sent')
        ).as('sent_count'),

        // failed messages
        applyDateFilter(
          this.query()
            .from('messages')
            .count('*')
            .where('user_id', userId)
            .andWhere('status', 'failed')
        ).as('failed_count'),

        // delivered messages
        applyDateFilter(
          this.query()
            .from('messages')
            .count('*')
            .where('user_id', userId)
            .andWhere('status', 'delivered')
        ).as('delivered_count'),

        // received messages
        applyDateFilter(
          this.query()
            .from('messages')
            .count('*')
            .where('user_id', userId)
            .andWhere('status', 'received')
        ).as('received_count'),

        // total messages
        applyDateFilter(
          this.query()
            .from('messages')
            .count('*')
            .where('user_id', userId)
        ).as('total_count'),

        // template messages
        applyDateFilter(
          this.query()
            .from('messages')
            .count('*')
            .where('user_id', userId)
            .andWhere('type', 'template')
        ).as('message_template_count'),

        // unique contacts
        applyDateFilter(
          this.query()
            .from('messages')
            .countDistinct('to_phone')
            .where('user_id', userId)
        ).as('unique_contacts_count'),

        // templates
        applyDateFilter(
          this.query()
            .from('templates')
            .count('*')
            .where('user_id', userId)
        ).as('templates_count'),
      )
      .first()
      .then((res: any) => ({
        ...res,
        total_messages:
          Number(res.sent_count) +
          Number(res.failed_count) +
          Number(res.delivered_count),
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

  async findAllUserByCompanyId(
  companyId?: string,
  role?: string,
  filterRole?: string,
  page: number = 1,
  limit: number = 10,
  ) {
    const isSuperAdmin = role === 'superadmin';

    const offset = (page - 1) * limit;

    const baseQuery = this.query()
      .from('users as u')
      .leftJoin(
        this.query().from('user_plans').select('*').where('active', true).orderBy('created_at', 'desc').as('up'),
        function () {
          this.on('up.id', '=', 'u.assigned_plan');
        },
      )
      .whereNull('u.deleted_at');

    // ✅ Restrict company for non-superadmin
    if (!isSuperAdmin) {
      baseQuery.where('u.company_id', companyId);
    }

    // ✅ Optional role filter
    if (filterRole) {
      baseQuery.where('u.role', filterRole);
    }

    // ✅ Total Count
    const totalResult = await baseQuery.clone().count('u.id as total').first();

    const total = Number(totalResult?.total || 0);

    // ✅ Paginated Data
    const data = await baseQuery
      .clone()
      .select('u.*', 'up.plan_name', 'up.start_date', 'up.end_date', 'up.active as plan_active')
      .offset(offset)
      .limit(limit)
      .orderBy('u.created_at', 'desc');

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async createUser(data: any) {
    const { name, email, phone, password, role, company_id } = data;

    return this.query()
      .insert({
        name,
        email,
        phone,
        password,
        role,
        company_id,
      })
      .returning('*')
      .then((res: any) => res[0]);
  }

  async updateUser(userId: string, data: any) {
    const updateData: any = {};
    console.log('Updating user with data:', data);

    // Basic fields
    if (data.name) updateData.name = data.name;
    if (data.email) updateData.email = data.email;
    if (data.phone) updateData.phone = data.phone;
    if (data.role) updateData.role = data.role;

    return this.query()
      .where({ id: userId })
      .update(updateData)
      .returning('*')
      .then((res: any) => res[0]);
  }

  async saveOtp(userId: string, otp: string, expiresAt: Date, email: string) {
    return this.query()
      .insert({
        user_id: userId,
        otp,
        expires_at: expiresAt,
      })
      .returning('*')
      .then((res: any) => res[0]);
  }
}

export default new UserModel();
