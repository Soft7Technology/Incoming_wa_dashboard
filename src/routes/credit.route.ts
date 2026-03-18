import { Router } from 'express';
import { requireRole } from '@surefy/middleware/jwtAuth.middleware';
import CreditController from '@surefy/console/http/controllers/credit.controller';

const CreditRoute = Router();

// All credit endpoints require JWT authentication (applied at route group level)

// Get balance (all authenticated users can view balance based on their role)
CreditRoute.get('/balance/:companyId', CreditController.getBalance);

// Get transactions (all authenticated users can view based on their role)
CreditRoute.get('/transactions/:companyId', CreditController.getTransactions);

// Add credits (admin/superadmin only)
CreditRoute.post('/add', requireRole('admin', 'superadmin'), CreditController.addCredit);

// Refund credits (admin/superadmin only)
CreditRoute.post('/refund', requireRole('admin', 'superadmin'), CreditController.refundCredit);

export default CreditRoute;
