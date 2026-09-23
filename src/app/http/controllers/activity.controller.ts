import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import activityService from '../../services/activity.service';

class ActivityController {
  getActivityLogs = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await activityService.getActivityLogs(req.companyId, req.userId!, req.userRole!, req.query);
    return successResponse(req, res, 'Activity logs retrieved successfully', result);
  });
  getActivityNotification = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await activityService.getActivityNotifications(req.userId!, req.companyId, req.userRole!, req.query);
    return successResponse(req, res, 'Notifications retrieved successfully', result);
  });
  getAdminNotification = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await activityService.getCompanyNotifications(req.userId!, req.companyId, req.userRole!, req.query);
    return successResponse(req, res, 'Notifications retrieved successfully', result);
  });
  readUserNotification = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await activityService.readUserNotification(
      req.userId!,
      req.companyId,
      req.userRole!,
      req.body?.data,
    );
    return successResponse(req, res, 'Notifications marked as read', result);
  });
}
export default new ActivityController();
