
import { Response, NextFunction } from 'express';
import HTTP401Error from '../exceptions/HTTP401Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import userPlansModel from '@surefy/console/app/models/userPlans.model';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';

export const checkPlanLimit = (type: 'Contact' | 'Campaign' | 'Chatbot') => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.userId!;
    console.log("UserId",userId)

    const plan = await userPlansModel.getPlanByUserId(userId);

    if (!plan) {
      // throw new HTTP401Error({ message: 'User Plan Not found or inactive' });
      return res.status(403).json({ message: 'No Active plan found. Subscribe to use Latest Features' });
    }

    const now = new Date();
    if (now < plan.start_date || now > plan.end_date) {
      // throw new HTTP401Error({ message: 'User Plan Expired' });
      return res.status(403).json({ message: `User ${plan.plan_name} Plan Expired` });
    }
    

    // ✅ JSON-based logic
    const limit = plan.limits?.[type]?.limit || 0;
    const used = plan.usage?.[type] || 0;
    console.log("Used, Limit",used,limit)

    if (used >= limit) {
      return res.status(403).json({
        message: `${type} Type Plan limit reached`
      });

      // return successResponse(req, res, `${type} Plan limit reached`, HttpStatusCode.OK);
    }

    next();
  };
};