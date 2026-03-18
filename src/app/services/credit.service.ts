import CompanyModel from '@surefy/console/models/company.model';
import CreditTransactionModel from '@surefy/console/models/creditTransaction.model';
import { AddCreditDto, DeductCreditDto } from '@surefy/console/interfaces/credit.interface';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';

class CreditService {
  /**
   * Get credit balance for company
   */
  async getBalance(companyId: string) {
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

  /**
   * Add credits (admin/superadmin only)
   */
  async addCredit(data: AddCreditDto & { user_role?: string }) {
    // Check authorization - only admin or superadmin can add credits
    if (data.user_role && data.user_role !== 'admin' && data.user_role !== 'superadmin') {
      throw new HTTP401Error({ message: 'Only admin or superadmin can add credits' });
    }

    const company = await CompanyModel.findById(data.company_id);
    if (!company) {
      throw new HTTP404Error({ message: 'Company not found' });
    }

    if (data.amount <= 0) {
      throw new HTTP400Error({ message: 'Amount must be greater than 0' });
    }

    const balanceBefore = parseFloat(company.credit_balance || '0');
    const balanceAfter = balanceBefore + data.amount;

    // Create transaction
    const transaction = await CreditTransactionModel.create({
      company_id: data.company_id,
      type: 'credit',
      amount: data.amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      description: data.description || 'Credit added',
      created_by: data.created_by,
      reference_type: 'manual',
    });

    // Update company balance
    await CompanyModel.update(data.company_id, {
      credit_balance: balanceAfter,
    });

    // Get updated company
    const updatedCompany = await CompanyModel.findById(data.company_id);

    return {
      transaction,
      company: updatedCompany,
      message: `Successfully added ${data.amount} credits to ${company.name}`,
    };
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
  async getTransactions(companyId: string, limit: number = 100) {
    return CreditTransactionModel.findByCompanyId(companyId, limit);
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
}

export default new CreditService();
