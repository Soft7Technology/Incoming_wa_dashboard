import CompanyModel from '@surefy/console/models/company.model';
import CreditTransactionModel from '@surefy/console/models/creditTransaction.model';
import { AddCreditDto, DeductCreditDto } from '@surefy/console/interfaces/credit.interface';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';
import creditTransactionModel from '@surefy/console/models/creditTransaction.model';
import db from '@surefy/database';
import { creditAmount, allowed, filters as validateFilters, requireInput, uuid } from '../utils/superAdminValidation';
import { PLATFORM_FEE_TYPES } from '../utils/creditLedger';

class CreditService {
  /**
   * Get credit balance for company
   */
  async getBalance(companyId: string, platformUserId?: string) {
    if (platformUserId) {
      return { ...await this.getPlatformBalance(platformUserId), company_id: companyId };
    }
    const company = await CompanyModel.findById(companyId);
    if (!company) {
      throw new HTTP404Error({ message: 'Company not found' });
    }

    const transactions = await CreditTransactionModel.findByCompanyId(companyId, 10);

    return {
      company_id: companyId,
      balance: company.credit_balance,
      last_transaction: transactions[0] || null,
    };
  }

  async getPlatformBalance(userId: string) {
    uuid(userId, 'userId');
    const user = await db('users').where({ id: userId, role: 'superadmin' }).whereNull('deleted_at')
      .first('id', 'credit_balance');
    if (!user) throw new HTTP404Error({ message: 'Platform wallet not found' });
    const [total, last] = await Promise.all([
      CreditTransactionModel.getPlatformFeeTotal(userId),
      CreditTransactionModel.getLatestPlatformTransaction(userId),
    ]);
    return { wallet_scope: 'platform', wallet_user_id: user.id, currency: 'INR',
      balance: user.credit_balance || '0', platform_fee_total: total, last_transaction: last || null };
  }

  async getPlatformTransactions(userId: string, query: Record<string, unknown> = {}) {
    uuid(userId, 'userId');
    allowed(query, ['page', 'limit', 'type', 'reference_type', 'from', 'to']);
    const { type, reference_type, ...rest } = query;
    requireInput(type === undefined || ['all', 'credit', 'debit', 'refund'].includes(type as string), 'Invalid transaction type');
    requireInput(reference_type === undefined || PLATFORM_FEE_TYPES.includes(reference_type as string), 'Invalid platform fee reference_type');
    const filters = { ...validateFilters(rest), type, reference_type };
    const result = await CreditTransactionModel.getPlatformTransactions(userId, filters);
    return { wallet_scope: 'platform', wallet_user_id: userId, ...result };
  }

  /**
   * Grant company credits without debiting the platform wallet.
   */
  async addCredit(userId:string,data: AddCreditDto & { user_role?: string }) {
    if (data.user_role !== 'superadmin') {
      throw new HTTP401Error({ message: 'Only superadmin can add credits' });
    }
    const amount = creditAmount(data.amount);
    return db.transaction(async trx => {
      const company = await trx('companies').where({ id: data.company_id }).whereNull('deleted_at').forUpdate().first();
      if (!company) throw new HTTP404Error({ message: 'Company not found' });
      const [updatedCompany] = await trx('companies').where({ id: company.id })
        .update({ credit_balance: trx.raw('credit_balance + ?::numeric', [amount]), updated_at: trx.fn.now() }).returning('*');
      const [transaction] = await trx('credit_transactions').insert({
        company_id: company.id, company_name: company.name, type: 'credit', amount,
        balance_before: company.credit_balance, balance_after: updatedCompany.credit_balance,
        description: `${amount} balance added to ${company.name}`, created_by: userId,
        balance_transafered_by: userId, reference_type: 'manual',
      }).returning('*');
      return { transaction, company: updatedCompany, message: `Successfully added ${amount} credits to ${company.name}` };
    });
  }

  /**
   * Deduct credits
   */
  async deductCredit(data: DeductCreditDto) {
    const company = await CompanyModel.findById(data.company_id);
    if (!company) {
      throw new HTTP404Error({ message: 'Company not found' });
    }

    if (data.amount <= 0) {
      throw new HTTP400Error({ message: 'Amount must be greater than 0' });
    }

    if (company.credit_balance < data.amount) {
      throw new HTTP400Error({ message: 'Insufficient credits' });
    }

    const balanceBefore = company.credit_balance;
    const balanceAfter = balanceBefore - data.amount;

    // Create transaction
    const transaction = await CreditTransactionModel.create({
      company_id: data.company_id,
      type: 'debit',
      amount: data.amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      reference_type: data.reference_type,
      reference_id: data.reference_id,
      description: data.description || 'Credit deducted',
    });

    // Update company balance
    await CompanyModel.update(data.company_id, {
      credit_balance: balanceAfter,
    });

    return transaction;
  }

  /**
   * Get transaction history
   */
  async getTransactions(companyId: string, filters:any, platformUserId?: string) {
    return CreditTransactionModel.getCompanyTransaction(companyId, filters, platformUserId);
  }

  /**
   * Refund credits
   */
  async refundCredit(companyId: string, transactionId: string, reason?: string) {
    const transaction = await CreditTransactionModel.findById(transactionId);
    if (!transaction) {
      throw new HTTP404Error({ message: 'Transaction not found' });
    }

    if (transaction.type !== 'debit') {
      throw new HTTP400Error({ message: 'Can only refund debit transactions' });
    }

    const company = await CompanyModel.findById(companyId);
    if (!company) {
      throw new HTTP404Error({ message: 'Company not found' });
    }

    const balanceBefore = company.credit_balance;
    const balanceAfter = balanceBefore + transaction.amount;

    // Create refund transaction
    const refund = await CreditTransactionModel.create({
      company_id: companyId,
      type: 'refund',
      amount: transaction.amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      reference_type: 'transaction',
      reference_id: transactionId,
      description: reason || 'Refund',
      created_by: 'system',
    });

    // Update company balance
    await CompanyModel.update(companyId, {
      credit_balance: balanceAfter,
    });

    return refund;
  }

  async transactionHistory(userId:string){
    const transactionHistory = await creditTransactionModel.transactionHistory(userId)
    return transactionHistory
  }
}

export default new CreditService();
