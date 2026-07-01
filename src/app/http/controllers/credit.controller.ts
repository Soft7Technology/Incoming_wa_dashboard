import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import CreditService from '@surefy/console/services/credit.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';

// Extended request interface for JWT auth
export interface JWTAuthRequest extends Request {
  userId?: string;
  userRole?: string;
  companyId?: string;
}

class CreditController {
  /**
   * GET /v1/credits/balance/:companyId
   * Get credit balance for a company
   */
  getBalance = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { companyId } = req.params;

    // Company users can only view their own balance
    if (req.userRole === 'company' || req.userRole === 'admin' && req.companyId !== companyId) {
      throw new HTTP400Error({ message: 'You can only view your own credit balance' });
    }

    const balance = await CreditService.getBalance(companyId);
    return successResponse(req, res, 'Credit balance retrieved successfully', balance);
  });

    /**
   * GET /v1/credits/balance/:companyId
   * Get credit balance for a company
   */
  getCompanyBalance = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    console.log("Company Id",req.companyId!,req.userRole!)

    // Company users can only view their own balance
    // if (req.userRole! === 'company' || req.userRole! === 'admin') {
    //   throw new HTTP400Error({ message: 'You can only view your own credit balance' });
    // }

    const balance = await CreditService.getBalance(req.companyId!);
    return successResponse(req, res, 'Credit balance retrieved successfully', balance);
  });

  /**
   * POST /v1/credits/add
   * Add credits to a company (admin/superadmin only)
   */
  addCredit = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { company_id, amount,company_name } = req.body;

    if (!company_id || !amount) {
      throw new HTTP400Error({ message: 'company_id and amount are required' });
    }

    if (amount <= 0) {
      throw new HTTP400Error({ message: 'Amount must be greater than 0' });
    }

    const result = await CreditService.addCredit(req.userId!,{
      company_id,
      company_name,
      amount: parseFloat(amount),
      created_by: req.userId!,
      user_role: req.userRole,
    });

    return successResponse(req, res, result.message, result, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/credits/transactions/:companyId
   * Get credit transaction history
   */
  getTransactions = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { companyId } = req.params;
    const filters = {
            type: req.query.type,
            time_frame: req.query.time_frame,
            page: req.query.page,
            limit: req.query.limit,
      };

    // Company users can only view their own transactions
    if (req.userRole === 'company' && req.companyId !== companyId) {
      throw new HTTP400Error({ message: 'You can only view your own transactions' });
    }

    const transactions = await CreditService.getTransactions(
      companyId,
      filters
    );

    return successResponse(req, res, 'Transactions retrieved successfully', transactions);
  });


    /**
   * GET /v1/credits/transactions/history
   * Get credit transaction history
   */
  getTransactionHistory = tryCatchAsync(async (req: AuthRequest, res: Response) => {
        const filters = {
            type: req.query.type,
            time_frame: req.query.time_frame,
            page: req.query.page,
            limit: req.query.limit,
        };

    // Company users can only view their own transactions
    // if (req.userRole === 'admin' || req.companyId!) {
    //   throw new HTTP400Error({ message: 'You can only view your own transactions' });
    // }

    const transactions = await CreditService.getTransactions(
      req.companyId!,
      filters
    );

    return successResponse(req, res, 'Transactions retrieved successfully', transactions);
  });

  /**
   * POST /v1/credits/refund
   * Refund a transaction (admin/superadmin only)
   */
  refundCredit = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { company_id, transaction_id, reason } = req.body;

    if (!company_id || !transaction_id) {
      throw new HTTP400Error({ message: 'company_id and transaction_id are required' });
    }

    // Only admin/superadmin can refund
    if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
      throw new HTTP400Error({ message: 'Only admin or superadmin can refund credits' });
    }

    const refund = await CreditService.refundCredit(company_id, transaction_id, reason);

    return successResponse(req, res, 'Credit refunded successfully', refund, HttpStatusCode.CREATED);
  });

  async superAdminTransaction(req:AuthRequest,res:Response){
    const transactionHistory = await CreditService.transactionHistory(req.userId!)
    return successResponse(req, res, 'Superadmin Transaction history retrieve successfully', transactionHistory , HttpStatusCode.CREATED);
  }
}

export default new CreditController();
