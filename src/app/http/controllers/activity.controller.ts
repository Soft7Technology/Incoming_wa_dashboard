import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import chatBotService from '../../services/chatbot.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import phoneNumberModel from '../../models/phoneNumber.model';
import userPlansModel from '../../models/userPlans.model';
import activityService from '../../services/activity.service';

class ActivityController {
    async getActivityLogs(req: JWTAuthRequest, res: Response) {
        const effectiveUserId = req.ownerId ?? req.userId!;
        const filters = {
            type: req.query.type,
            page: req.query.page,
            limit: req.query.limit,
            search: req.query.search,
            sorted_by: req.query.sorted_by,
            sort_order: req.query.sort_order,
        }
        console.log("Role",req.query.role)
        const userActivities = await activityService.getAcitvityLogs(req.companyId!, effectiveUserId, req.query.role!, filters)
        successResponse(req, res, "Activity Logs retrived succesfully", userActivities)
    }

    async getActivityNotification(req: JWTAuthRequest, res: Response) {
        const effectiveUserId = req.ownerId ?? req.userId!;
        const filters = {
            type: req.query.type,
            time_frame: req.query.time_frame,
            page: req.query.page,
            limit: req.query.limit,
        };
        const role = req.query.role

        const notifications =
            await activityService.getActivityNotifications(
                effectiveUserId,
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

    async getAdminNotification(req: JWTAuthRequest, res: Response) {
        const effectiveUserId = req.ownerId ?? req.userId!;
        const filters = {
            type: req.query.type,
            time_frame: req.query.time_frame,
            page: req.query.page,
            limit: req.query.limit,
        };
        const role = req.query.role

        const notifications =
            await activityService.getCompanyNotifications(
                effectiveUserId,
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

    async readUserNotification(req: JWTAuthRequest, res: Response){
        const effectiveUserId = req.ownerId ?? req.userId!;
        const{read} = req.query
        const{data} = req.body
        const updateNotification = await activityService.readUserNotification(effectiveUserId, req.companyId!, data)
        successResponse(req,res,"User Notification read",updateNotification)
    }
}

export default new ActivityController()
