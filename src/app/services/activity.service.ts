import CompanyRepository from '@surefy/console/repository/company.repository';
import { CreateCompanyDto, UpdateCompanyDto } from '@surefy/console/interfaces/company.interface';
import { generateCompanyKey } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import AuthService from './auth.service';
import userModel from '../models/user.model';
import activityLogsModel from '../models/activityLogs.model';

class ActivityService {
    async getAcitvityLogs(company_id:string,user_id:string,role:any,filter:any){
        const activities = await activityLogsModel.getAllActivities(user_id,company_id,role,filter)
        return activities
    }

    async getActivityNotifications(user_id:string,company_id:string,role:any,filters:any){
        const activityNotification = await activityLogsModel.getActivityNotifications(user_id,company_id,role,filters)
        return activityNotification
    }

    async getCompanyNotifications(user_id:string,company_id:string,role:any,filters:any){
        const activityNotification = await activityLogsModel.getCompanyNotifications(user_id,company_id,role,filters)
        return activityNotification
    }
}


export default new ActivityService();