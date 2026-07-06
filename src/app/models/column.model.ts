import { BaseModel } from '@surefy/models/base.model';

class ColumnModel extends BaseModel {
  constructor() {
    super('columns');
  }

  async findByCompany(companyId: string) {
    return this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at')
      .orderBy('created_at', 'asc');
  }

  async findByUser(userId: string) {
    return this.query()
      .where({ user_id: userId })
      .whereNull('deleted_at')
      .orderBy('created_at', 'asc');
  }
}

export default new ColumnModel();
