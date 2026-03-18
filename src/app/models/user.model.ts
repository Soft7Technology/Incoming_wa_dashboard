import { BaseModel } from '@surefy/models/base.model';

class UserModel extends BaseModel {
  constructor() {
    super('users');
  }

  async findByEmail(email: string) {
    return this.query()
      .where({ email })
      .whereNull('deleted_at')
      .first();
  }

  async findByPhone(phone: string) {
    return this.query()
      .where({ phone })
      .whereNull('deleted_at')
      .first();
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
    let query = this.query()
      .where({ role })
      .whereNull('deleted_at');

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
}

export default new UserModel();
