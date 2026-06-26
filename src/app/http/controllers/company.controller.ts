import { raw, Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import CompanyService from '@surefy/console/services/company.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import subscriptionModel from '@surefy/console/models/subscription.model'
import userPlansModel from '../../models/userPlans.model';
import companyService from '@surefy/console/services/company.service';
import sendEmail from '../../utils';
import MessageService from '../../services/message.service';
import { uploadImage } from '@surefy/config/firebase.config';
import activityLogsModel from '../../models/activityLogs.model';
import userTeamModel from '../../models/team.model';
import userModel from '../../models/user.model';


class CompanyController {
  /**
   * POST /v1/companies
   * Onboard new company
   */
  onboard = tryCatchAsync(async (req: Request, res: Response) => {

    const { name, email, phone, domain, status, business_id, webhook_url, meta_config, settings, credit_balance} = req.body;
    const user = typeof req.body.user === 'string' ? JSON.parse(req.body.user) : req.body.user;

    const file: Express.Multer.File | undefined = req.file


    console.log("File", file)

    let logo = null

    if (file) {
      logo = await uploadImage(file)
    }

    if (!name || !email) {
      throw new HTTP400Error({ message: 'Name and email are required' });
    }

    if (!user || !user.name || !user.password || (!user.email && !user.phone)) {
      throw new HTTP400Error({
        message: 'User details are required: name, password, and either email or phone'
      });
    }

    const result = await CompanyService.onboardCompany({
      name,
      email,
      phone,
      domain,
      status,
      business_id,
      webhook_url,
      meta_config,
      settings,
      credit_balance,
      user,
      logo
    });

    if (result) {
      await sendEmail(
        email,
        'Welcome to Our Platform',
        `Hi ${name},\n\nWelcome to our platform! Your account has been created successfully. You can now log in using your Email: ${email} or Phone: ${phone}.\n\nBest regards,\nThe Soft 7 Team`,
      )
    }

    return successResponse(req, res, 'Company and user created successfully', result, HttpStatusCode.CREATED);
  });

  getCompanyDetails = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const companyDetails = await companyService.getCompanyDetails(req.companyId!)
    return successResponse(req, res, "Company Retrived successfully", companyDetails, HttpStatusCode.ACCEPTED)
  })

  /**
   * GET /v1/companies/:id
   * Get company details
   */
  getById = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const company = await CompanyService.getCompanyById(id);
    return successResponse(req, res, 'Company retrieved successfully', company);
  });

  getUserStats = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    // Use ownerId so team members see the account owner's stats
    const effectiveUserId = req.ownerId ?? req.userId!
    console.log("Effective User Id (ownerId ?? userId)", effectiveUserId)
    const { time_frame } = req.query
    const userStats = await MessageService.getUserStats(effectiveUserId, time_frame)
    return successResponse(req, res, 'User Stats retrieved successfully', userStats)
  })

  getUserDetails = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    // console.log("User Id",req.userId!)
    const { userId } = req.params
    const userStats = await CompanyService.getUserStats(userId)
    return successResponse(req, res, 'User Stats retrieved successfully', userStats)
  })


  /**
   * GET /v1/companies/all
   * Get all companies
   */
  getAllCompanies  = tryCatchAsync(async (req: Request, res: Response) => {
    const{status} = req.query
    const companies = await CompanyService.getAllCompanies(status);
    return successResponse(req, res, 'Companies retrieved successfully', companies);
  });

  /**
   * PUT /v1/companies/:id
   * Update company
   */
  updateCompany = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    let data = req.body
    const file = req.file
    if (file) {
      data.logo = await uploadImage(file)
    }
    
    // Use route param if present (super admin updating any company), fall back to JWT companyId
    const targetCompanyId = (req.params as any).companyId || req.companyId!;
    const company = await CompanyService.updateCompany(targetCompanyId, data);
    return successResponse(req, res, 'Company updated successfully', company);
  });

  /**
   * DELETE /v1/companies/:id
   * Delete company
   */
  deleteCompany = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { companyId } = req.params;
    await CompanyService.deleteCompany(companyId);
    return successResponse(req, res, 'Company deleted successfully');
  });

  /**
   * POST /v1/companies/user
   * Create user under company
   */
  createUser = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { name, email, phone, password, role, assigned_plan } = req.body;
    console.log("Creating user with data:", { name, email, phone, role })

    if (!name || !email || !password) {
      throw new HTTP400Error({ message: 'Name, email, and password are required' });
    }

    const createdUser = await CompanyService.createUser(req.companyId!, { name, email, phone, password, role, assigned_plan })
    const { data }: any = createdUser
    await activityLogsModel.create({
      user_id: data?.id, // User who performed the action

      action: 'CREATE',
      entity_type: 'USER',
      entity_id: data?.id,

      description: `Created user ${data?.name} (${data?.email})`,
      read:false,

      new_data: {
        id: data?.id,
        name: data?.name,
        email: data?.email,
        role: data?.role,
        assigned_plan: data?.assigned_plan
      },

      ip_address:
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '',

      user_agent: req.headers['user-agent'] || '',

      request_method: req.method,
      api_endpoint: req.originalUrl,

      status: 'SUCCESS'
    });
    return successResponse(req, res, 'User created successfully', createdUser);
  })

  /**
   * GET /v1/user/notifications
   */
  // getNotifications = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
  //   const notifications = await CompanyService.getNotifications(req.userId!)
  //   return successResponse(req,res, 'User notifications retrieved successfully', notifications)
  // })

  /**
   * POST /v1/companies/:id/regenerate-keys
   * Regenerate company API keys
   */
  regenerateKeys = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { id } = req.params;

    const user = {
      role: req.userRole,
      company_id: req.companyId,
    };

    const keys = await CompanyService.regenerateKeys(id, user);
    return successResponse(req, res, 'API credentials retrieved successfully', keys);
  });

  getdashboardStats = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    // Use ownerId so team members see the account owner's dashboard
    const effectiveUserId = req.ownerId ?? req.userId!
    console.log("Fetching dashboard stats for effectiveUserId:", effectiveUserId);
    const stats = await CompanyService.getDashboardStats(req.companyId!, effectiveUserId)
    return successResponse(req, res, 'Dashboard stats retrieved successfully', stats)
  })

  getAllUsers = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { role } = req.query
    console.log("Fetching users with role filter:", role) // Debug log
    const users = await CompanyService.getAllUsers(req.userId!, req.companyId!, role)
    return successResponse(req, res, 'Users retrieved successfully', users)
  })

  getAdminUsers = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const users = await CompanyService.getAllUsers(req.userId!, req.companyId!)
    const adminUsers = users.filter((user: any) => user.role === 'admin')
    return successResponse(req, res, 'Admin users retrieved successfully', adminUsers)
  })

  getUser = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const user = await CompanyService.getUserById(req.userId!)
    return successResponse(req, res, 'User retrieved successfully', user)
  })

  updateCompanyUser = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { name, email, phone, permissions, assigned_plan } = req.body;
    const { id } = req.params

    const updatedUser = await CompanyService.updateCompanyUser(id, { name, email, phone, permissions, assigned_plan })
    const { data } = updatedUser
    await activityLogsModel.create({
      user_id: data?.id, // user performing the update

      action: 'UPDATE',
      entity_type: 'USER',
      entity_id: id,
      read:false,

      description: `Updated user ${data?.name}`,

      new_data: {
        name: data?.name,
        email: data?.email,
        phone: data?.phone,
        permissions: data?.permissions,
        assigned_plan: data?.assigned_plan
      },

      ip_address:
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '',

      user_agent: req.headers['user-agent'] || '',

      request_method: req.method,
      api_endpoint: req.originalUrl,

      status: 'SUCCESS'
    });

    return successResponse(req, res, 'User updated successfully', updatedUser)
  })

  getCompanyUser = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const{userId} = req.params
    const user = await CompanyService.getUserById(userId)
    successResponse(req,res,'Company User Details',user)
  })

  //   razorpayOrderId: "order_SgA55nIqCKdwUs"
  // razorpayPaymentId: "pay_SgA5A5oB9Btmgy"
  // razorpaySignature: "adac4d8719b1813682dfcbc4ade953903f69ab75bf7c09ca47ce9c3bd51ab17b"
  // subscribePlan = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
  //   const {planId} = req.params
  //   console.log("Subscribing to plan with query:", planId) // Debug log

  //   const userPlan = await userPlansModel.getPlanByUserId(req.userId!)
  //   if(userPlan){
  //     throw new HTTP400Error({message: 'User Plan already exists'})
  //   }

  //   const planData = await subscriptionModel.findById(planId as string)
  //   if(!planData){
  //     throw new HTTP400Error({message: 'Subscription Plan not found'})
  //   }
  //   const subscribePlan = await CompanyService.createUserPlan(req.userId!, planData)
  //   return successResponse(req,res, 'Plan subscribed successfully', subscribePlan)
  // })

  async getUserPlan(req: AuthRequest, res: Response) {
    const { userId } = req.params
    console.log("UserId", userId)
    const userPlan = await userPlansModel.getUserPlan(userId)
    if (!userPlan) {
      return successResponse(req, res, 'No active plan for user', null)
    }
    return successResponse(req, res, 'User plan retrieved successfully', userPlan)
  }

  async checkUserPlanStatus(req: AuthRequest, res: Response) {
    try {
      const effectiveUserId = req.ownerId ?? req.userId!;
      console.log("Checking user plan status for effectiveUserId:", effectiveUserId);

      const userPlan = await userPlansModel.getUserPlan(effectiveUserId)
      if (!userPlan) {
        return successResponse(req, res, 'No Active Plan found', userPlan)
      }
      return successResponse(req, res, 'User has an active plan', userPlan)

    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Something went wrong',
      });
    }
  }

  async getAllUserPlans(req:AuthRequest,res:Response){
    const userPlans = await userPlansModel.getAllUserPlan(req.userId!)
    successResponse(req,res,"All User Plans",userPlans)
  }

  async getUserById(req: AuthRequest, res: Response) {
    const { userId } = req.params
    const user = await CompanyService.getUserById(userId)
    return successResponse(req, res, "User retrieved successfully", user)
  }

  async deleteCompanyUser(req: AuthRequest, res: Response) {
    const { id } = req.params
    const deleteUser = await CompanyService.deleteUserById(id)
    return successResponse(req, res, 'Company User deleted successfully', deleteUser);
  }

  async getReminders(req: AuthRequest, res: Response) {
    return successResponse(req, res, "No reminder for now", HttpStatusCode.OK)
  }

  async getCompaniesSubscription(req: AuthRequest, res: Response) {
    const { active } = req.query
    const companySubscriptions = await companyService.getcompanySubscriptions(req.userId!, req.companyId!, active)
    return successResponse(req, res, "Company User Active subscriptions plans", companySubscriptions, HttpStatusCode.OK)
  }

  async updateUser(req: AuthRequest, res: Response) {
    const { id } = req.params;

    const company = await CompanyService.updateUser(id, req.body);

    await activityLogsModel.create({
      company_id: req.companyId,
      user_id: req.userId,

      action: 'UPDATE',
      entity_type: 'USER',
      entity_id: id,
      read:false,
      description: `Updated user ${id}`,

      new_data: req.body,

      ip_address:
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '',

      user_agent: req.headers['user-agent'] || '',

      request_method: req.method,
      api_endpoint: req.originalUrl,

      status: 'SUCCESS'
    });

    return successResponse(req, res, 'Company updated successfully', company);
  }

  async resetUserPassword(req: JWTAuthRequest, res: Response) {
    const { id } = req.params;
    const { password } = req.body;

    if (!password) {
      throw new HTTP400Error({ message: 'Password is required' });
    }

    if (password.length < 6) {
      throw new HTTP400Error({ message: 'Password must be at least 6 characters long' });
    }

    if (req.userRole !== 'superadmin' && req.userRole !== 'admin') {
      throw new HTTP403Error({ message: 'Unauthorized to reset user password' });
    }

    const resetResult = await CompanyService.resetUserPassword(id, password);

    await activityLogsModel.create({
      company_id: req.companyId,
      user_id: req.userId,

      action: 'UPDATE',
      entity_type: 'USER',
      entity_id: id,
      read: false,
      description: `Reset password for user ${id}`,

      new_data: { password_reset: true },

      ip_address:
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '',

      user_agent: req.headers['user-agent'] || '',

      request_method: req.method,
      api_endpoint: req.originalUrl,

      status: 'SUCCESS'
    });

    return successResponse(req, res, 'User password reset successfully', resetResult);
  }

  async suspendUser(req: AuthRequest, res: Response) {
    const { id } = req.params;

    // Resolve real users.id — the frontend may send user_team.id
    let userId = id;
    const directUser = await userModel.findById(id);
    if (!directUser) {
      // Try resolving via user_team (team invite id)
      const teamRow = await userTeamModel.findById(id);
      if (!teamRow) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      const realUser = await userModel.findOne({ email: teamRow.email });
      if (!realUser) {
        return res.status(404).json({ success: false, message: 'User account not found for this invite' });
      }
      userId = realUser.id;
    }

    const suspendUser = await CompanyService.suspendUser(userId);

    await activityLogsModel.create({
      company_id: req.companyId,
      user_id: req.userId,
      action: 'SUSPEND',
      entity_type: 'USER',
      entity_id: userId,
      read: false,
      description: `Suspended user account ${id}`,
      new_data: { suspended_user_id: userId },
      ip_address: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
      user_agent: req.headers['user-agent'] || '',
      request_method: req.method,
      api_endpoint: req.originalUrl,
      status: 'SUCCESS'
    });

    successResponse(req, res, 'User Suspended Successfully', suspendUser, HttpStatusCode.CREATED);
  }

  async suspendUserPlan(req: AuthRequest, res: Response) {
    const { userId } = req.query;

    const userActivePlan = await userPlansModel.getPlanByUserId(userId);

    if (!userActivePlan) {
      throw new HTTP400Error({
        message: "User have no active plan",
      });
    }

    const suspendUserPlan = await userPlansModel.update(
      userActivePlan.id,
      {
        status: "EXPIRED",
        active: false
      }
    );

    await activityLogsModel.create({
      company_id: req.companyId,
      user_id: req.userId,

      action: 'SUSPEND',
      entity_type: 'SUBSCRIPTION',
      entity_id: userActivePlan.id,
      read:false,

      description: `Suspended user subscription plan`,

      old_data: {
        status: userActivePlan.status,
        active: userActivePlan.active
      },

      new_data: {
        status: 'EXPIRED',
        active: false
      },

      ip_address:
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '',

      user_agent: req.headers['user-agent'] || '',

      request_method: req.method,
      api_endpoint: req.originalUrl,

      status: 'SUCCESS'
    });

    successResponse(
      req,
      res,
      "User Plan suspended successfully",
      suspendUserPlan
    );
  }

  async activateUser(req: AuthRequest, res: Response) {
    const { id } = req.params;

    // Resolve real users.id — the frontend may send user_team.id
    let userId = id;
    const directUser = await userModel.findById(id);
    if (!directUser) {
      const teamRow = await userTeamModel.findById(id);
      if (!teamRow) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      const realUser = await userModel.findOne({ email: teamRow.email });
      if (!realUser) {
        return res.status(404).json({ success: false, message: 'User account not found for this invite' });
      }
      userId = realUser.id;
    }

    const activateUser = await CompanyService.activateSingleUser(userId);

    await activityLogsModel.create({
      company_id: req.companyId,
      user_id: req.userId,
      action: 'ACTIVATE',
      entity_type: 'USER',
      entity_id: userId,
      read: false,
      description: `Activated user account`,
      new_data: { user_id: userId, status: 'active' },
      ip_address: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
      user_agent: req.headers['user-agent'] || '',
      request_method: req.method,
      api_endpoint: req.originalUrl,
      status: 'SUCCESS'
    });

    successResponse(req, res, 'User Activated Successfully', activateUser, HttpStatusCode.CREATED);
  }

  async suspendCompany(req:AuthRequest,res:Response){
    const{companyId} = req.params
    const suspendCompany = await companyService.suspendCompany(companyId)
    successResponse(req,res,'Company Suspended successfully', suspendCompany)
  }

  async activeCompany(req:AuthRequest,res:Response){
    const{companyId} = req.params
    const activeCompany = await companyService.activateUser(companyId)
    successResponse(req,res,'Company Active successfully',activeCompany)
  }


  // async updateCompanyUser(req:AuthRequest,res:Response){
  //   const 
  // }
}

export default new CompanyController();
