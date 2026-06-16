import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import chatBotService from '../../services/chatbot.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import wabaModel from '../../models/waba.model';
import phoneNumberModel from '../../models/phoneNumber.model';
import userPlansModel from '../../models/userPlans.model';
import activityService from '../../services/activity.service';

class ActivityController {
    async getActivityLogs(req: AuthRequest, res: Response) {
        const filters = {
            type: req.query.type,
            page: req.query.page,
            limit: req.query.limit,
            search: req.query.search,
            sorted_by: req.query.sorted_by,
            sort_order: req.query.sort_order,
        }
        console.log("Role",req.query.role)
        const userActivities = await activityService.getAcitvityLogs(req.companyId!, req.userId!, req.query.role!, filters)
        successResponse(req, res, "Activity Logs retrived succesfully", userActivities)
    }

    async getActivityNotification(req: AuthRequest, res: Response) {
        const filters = {
            type: req.query.type,
            time_frame: req.query.time_frame,
            page: req.query.page,
            limit: req.query.limit,
        };
        const role = req.query.role

        const notifications =
            await activityService.getActivityNotifications(
                req.userId!,
                req.companyId!,
                role,
                filters
            );

        return successResponse(
            req,
            res,
            "Notifications retrieved successfully",
            notifications
        );
    }

    async getAdminNotification(req: AuthRequest, res: Response) {
        const filters = {
            type: req.query.type,
            time_frame: req.query.time_frame,
            page: req.query.page,
            limit: req.query.limit,
        };
        const role = req.query.role

        const notifications =
            await activityService.getCompanyNotifications(
                req.userId!,
                req.companyId!,
                role,
                filters
            );

        return successResponse(
            req,
            res,
            "Notifications retrieved successfully",
            notifications
        );
    }
}

export default new ActivityController()
