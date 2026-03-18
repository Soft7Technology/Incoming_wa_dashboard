import { BaseModel } from '@surefy/models/base.model';

class CompanyModel extends BaseModel {
  constructor() {
    super('companies');
  }

  async findByApiKey(apiKey: string) {
    return this.query().where({ api_key: apiKey, status: 'active' }).first();
  }

  async findByEmail(email: string) {
    return this.query().where({ email }).first();
  }

  async updateCreditBalance(companyId: string, amount: number) {
    return this.query()
      .where({ id: companyId })
      .increment('credit_balance', amount)
      .returning('*');
  }
}

export default new CompanyModel();
