import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import userPlansModel from '@surefy/console/app/models/userPlans.model';
import { checkUsage, PlanFeature } from '@surefy/console/app/services/planUsage.service';

export const checkPlanLimit = (feature: PlanFeature) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const plan = await userPlansModel.getPlanByUserId(req.ownerId ?? req.userId!);
      checkUsage(plan, feature);
      next();
    } catch (error) { next(error); }
  };
};
