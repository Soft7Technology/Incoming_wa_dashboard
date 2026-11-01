import { BaseModel } from '@surefy/models/base.model';
import { companyWallet, platformFees } from '../utils/creditLedger';
import { Knex } from 'knex';

class CreditTransactionModel extends BaseModel {
  constructor() {
    super('credit_transactions');
  }

  async findByCompanyId(companyId: string, limit: number = 100) {
    return companyWallet(this.query(), this.db)
      .where({ company_id: companyId })
      .orderBy('created_at', 'desc')
      .limit(limit);
  }


  async getCompanyTransaction(companyId: string, filters: any, platformUserId?: string) {
    if (platformUserId) return this.getPlatformTransactions(platformUserId, filters);
    return this.paginate(companyWallet(this.query(), this.db).where({ company_id: companyId }), filters);
  }

  /** Platform wallet ownership is the authenticated user, regardless of company links. */
  async getPlatformTransactions(userId: string, filters: any = {}) {
    const query = platformFees(this.query(), this.db).where('user_id', userId);
    if (filters.reference_type) query.where('reference_type', filters.reference_type);
    if (filters.from) query.where('created_at', '>=', filters.from);
    if (filters.to) query.where('created_at', '<', filters.to);
    return this.paginate(query, filters);
  }

  async getPlatformFeeTotal(userId: string) {
    const result = await platformFees(this.query(), this.db).where('user_id', userId)
      .sum('amount as total').first();
    return Number(result?.total || 0);
  }

  async getLatestPlatformTransaction(userId: string) {
    return platformFees(this.query(), this.db).where('user_id', userId)
      .orderBy('created_at', 'desc').orderBy('id', 'desc').first();
  }

  private async paginate(query: Knex.QueryBuilder, filters: any = {}) {
    const page = parseInt(filters?.page) || 1;
    const limit = parseInt(filters?.limit) || 10;
    const offset = (page - 1) * limit;

    // Apply type filter only when type is not "all"
    if (filters?.type && filters.type.toLowerCase() !== 'all') {
      query = query.andWhere({ type: filters.type });
    }

    // Get total count
    const totalResult = await query
      .clone()
      .count('* as total')
      .first();

    const total = Number(totalResult?.total || 0);

    // Get paginated data
    const data = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPreviousPage: page > 1,
      },
    };
  }

  async getTotalCredits(companyId: string): Promise<number> {
    const result = await companyWallet(this.query(), this.db)
      .where({ company_id: companyId }).whereIn('type', ['credit', 'refund'])
      .sum({ total: this.db.raw('ABS(amount::numeric)') })
      .first();
    return parseFloat(result?.total || 0);
  }

  async getTotalDebits(companyId: string): Promise<number> {
    const result = await companyWallet(this.query(), this.db)
      .where({ company_id: companyId, type: 'debit' })
      .sum({ total: this.db.raw('ABS(amount::numeric)') })
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
    let query = companyWallet(this.query(), this.db).where({ company_id: companyId });

    if (filters.reference_type) {
      query = query.where({ reference_type: filters.reference_type });
    }

    if (filters.type) {
      query = query.where({ type: filters.type });
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

    const stats = await companyWallet(this.query(), this.db)
      .where({ company_id: companyId })
      .where('created_at', '>=', startDate)
      .select('type')
      .sum({ total: this.db.raw('ABS(amount::numeric)') })
      .count('* as count')
      .groupBy('type');

    return stats;
  }

  async transactionHistory(userId: string) {
    return await platformFees(this.query(), this.db)
      .where('user_id', userId)
      .orderBy('created_at', 'desc');
  }
}

export default new CreditTransactionModel();
// Trigger restart
