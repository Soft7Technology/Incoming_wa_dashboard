import { Router } from 'express';
import activityController from '../app/http/controllers/activity.controller';

const activityRoute = Router()

activityRoute.get('/',activityController.getActivityLogs)
activityRoute.get('/user/notify', activityController.getActivityNotification)
activityRoute.get('/admin/notify',activityController.getAdminNotification)
activityRoute.put('/user/notify',activityController.readUserNotification)
// activityRoute.get('/', )

export default activityRoute;