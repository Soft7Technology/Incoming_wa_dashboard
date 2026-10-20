import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import planUsage, { PlanFeature } from '@surefy/console/app/services/planUsage.service';

export const checkPlanLimit = (feature: PlanFeature) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await planUsage.assert(req.ownerId ?? req.userId!, feature);
      next();
    } catch (error) { next(error); }
  };
};
