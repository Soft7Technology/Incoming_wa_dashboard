import { Router } from 'express';
import activityController from '../app/http/controllers/activity.controller';

const activityRoute = Router()

activityRoute.get('/',activityController.getActivityLogs)
activityRoute.get('/user/notify', activityController.getActivityNotification)
// activityRoute.get('/', )

export default activityRoute;