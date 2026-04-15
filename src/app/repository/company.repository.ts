import CompanyModel from '@surefy/console/models/company.model';
import CreditTransactionModel from '@surefy/console/models/creditTransaction.model';
import { CreateCompanyDto, UpdateCompanyDto } from '@surefy/console/interfaces/company.interface';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

class CompanyRepository {
  /**
   * Generate API key for company
   */
  private generateApiKey(): string {
    return `sk_${crypto.randomBytes(32).toString('hex')}`;
  }

  async getDashboardStats(companyId:string){
    const stats = await CompanyModel.getDashboardStats(companyId)
    return stats
  }

  /**
   * Create new company
   */
  async create(data: CreateCompanyDto) {
    const apiKey = this.generateApiKey();
    const webhookVerifyToken = crypto.randomBytes(32).toString('hex');
    const initialCredit = data.initial_credit || 0;

    // Remove initial_credit from data as it's not a database column
    const { initial_credit, ...companyData } = data;

    const company = await CompanyModel.create({
      ...companyData,
      api_key: apiKey,
      webhook_verify_token: webhookVerifyToken,
      credit_balance: initialCredit,
    });

    // Create initial credit transaction if credits provided
    if (initialCredit > 0) {
      await CreditTransactionModel.create({
        company_id: company.id,
        type: 'credit',
        amount: initialCredit,
        balance_before: 0,
        balance_after: initialCredit,
        description: 'Initial credit',
        created_by: 'system',
      });
    }

    return company;
  }

  /**
   * Find company by ID
   */
  async findById(id: string) {
    return CompanyModel.findById(id);
  }


  async getUserStats(userId:string){
    return CompanyModel.getUserStats(userId)
  }


  /**
   * Find company by API key
   */
  async findByApiKey(apiKey: string) {
    return CompanyModel.findByApiKey(apiKey);
  }

  /**
   * Find company by email
   */
  async findByEmail(email: string) {
    return CompanyModel.findByEmail(email);
  }

  /**
   * Update company
   */
  async update(id: string, data: UpdateCompanyDto) {
    return CompanyModel.update(id, { ...data, updated_at: new Date() });
  }

  /**
   * Delete company (soft delete)
   */
  async delete(id: string) {
    return CompanyModel.update(id, { deleted_at: new Date() });
  }

  /**
   * Get all companies
   */
  async getAll(filters: any = {}) {
    return CompanyModel.findAll(filters);
  }
}

export default new CompanyRepository();
