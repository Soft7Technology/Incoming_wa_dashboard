import { ActivityQuery } from '../interfaces/activity.interface';
import activityLogsModel from '../models/activityLogs.model';

class ActivityService {
  getActivityLogs(companyId: string | undefined, userId: string, role: string, filters: ActivityQuery) {
    return activityLogsModel.getAllActivities(userId, companyId, role, filters);
  }
  getActivityNotifications(userId: string, companyId: string | undefined, role: string, filters: ActivityQuery) {
    return activityLogsModel.getActivityNotifications(userId, companyId, role, filters);
  }
  getCompanyNotifications(userId: string, companyId: string | undefined, role: string, filters: ActivityQuery) {
    return activityLogsModel.getCompanyNotifications(userId, companyId, role, filters);
  }
  readUserNotification(userId: string, companyId: string | undefined, role: string, data: unknown) {
    return activityLogsModel.markRead(userId, companyId, role, data);
  }
}
export default new ActivityService();
