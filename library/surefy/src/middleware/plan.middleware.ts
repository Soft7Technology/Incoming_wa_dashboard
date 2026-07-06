
import { Response, NextFunction } from 'express';
import HTTP401Error from "@surefy/exceptions/HTTP401Error";
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import userPlansModel from '@surefy/console/app/models/userPlans.model';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';

export const checkPlanLimit = (type: 'Contact' | 'Campaign' | 'Chatbot' | 'Message' | 'Tag') => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.userId!;
    const plan = await userPlansModel.getPlanByUserId(userId);


    console.log("Plan", plan)

    if (!plan) {
      // throw new HTTP401Error({ message: 'User Plan Not found or inactive' });
      return res.status(403).json({ message: 'No Active plan found. Subscribe to use Latest Features' });
    }

    const now = new Date();
    console.log("Start Date",now)

    if (now < plan.start_date) {
      return res.status(403).json({
        message: 'Plan has not started yet'
      });
    }

    if (now > plan.end_date) {
      await userPlansModel.update(plan.id, {
        status: 'EXPIRED',
        active: false
      });

      return res.status(403).json({
        message: `User ${plan.plan_name} Plan Expired`
      });
    }

    // ✅ JSON-based logic
    const limit = plan.limits?.[type]?.limit;
    const used = plan.usage?.[type];
    console.log("Plan Limits", plan.limits, type, limit)

    if (used >= limit && limit !== null) {
      return res.status(403).json({
        message: `${type} Type Plan limit reached`
      });
    }

    next();
  };
};