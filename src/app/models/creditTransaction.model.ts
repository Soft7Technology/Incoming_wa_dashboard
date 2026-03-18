import { BaseModel } from '@surefy/models/base.model';

class CreditTransactionModel extends BaseModel {
  constructor() {
    super('credit_transactions');
  }

  async findByCompanyId(companyId: string, limit: number = 100) {
    return this.query()
      .where({ company_id: companyId })
      .orderBy('created_at', 'desc')
      .limit(limit);
  }

  async getTotalCredits(companyId: string): Promise<number> {
    const result = await this.query()
      .where({ company_id: companyId, type: 'credit' })
      .sum('amount as total')
      .first();
    return parseFloat(result?.total || 0);
  }

  async getTotalDebits(companyId: string): Promise<number> {
    const result = await this.query()
      .where({ company_id: companyId, type: 'debit' })
      .sum('amount as total')
      .first();
    return parseFloat(result?.total || 0);
  }

  async getBalance(companyId: string): Promise<number> {
    const credits = await this.getTotalCredits(companyId);
    const debits = await this.getTotalDebits(companyId);
    return credits - debits;
  }

  async createTransaction(data: {
    company_id: string;
    type: 'credit' | 'debit' | 'refund';
    amount: number;
    balance_before: number;
    balance_after: number;
    reference_type?: string;
    reference_id?: string;
    description?: string;
    created_by: string;
    meta_data?: any;
  }) {
    return this.create(data);
  }

  async findByCompany(companyId: string, filters: any = {}) {
    let query = this.query().where({ company_id: companyId });

    if (filters.type) {
      query = query.where({ type: filters.type });
    }

    if (filters.reference_type) {
      query = query.where({ reference_type: filters.reference_type });
    }

    if (filters.start_date) {
      query = query.where('created_at', '>=', filters.start_date);
    }

    if (filters.end_date) {
      query = query.where('created_at', '<=', filters.end_date);
    }

    return query.orderBy('created_at', 'desc');
  }

  async getTransactionStats(companyId: string, period: 'day' | 'week' | 'month' | 'year' = 'month') {
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case 'day':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
    }

    const stats = await this.query()
      .where({ company_id: companyId })
      .where('created_at', '>=', startDate)
      .select('type')
      .sum('amount as total')
      .count('* as count')
      .groupBy('type');

    return stats;
  }
}

export default new CreditTransactionModel();
