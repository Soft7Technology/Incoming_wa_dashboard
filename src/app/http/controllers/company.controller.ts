import { raw, Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import CompanyService from '@surefy/console/services/company.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import subscriptionModel from '@surefy/console/models/subscription.model'
import userPlansModel from '../../models/userPlans.model';
import companyService from '@surefy/console/services/company.service';
import sendEmail from '../../utils';
import MessageService from '../../services/message.service';

class CompanyController {
  /**
   * POST /v1/companies
   * Onboard new company
   */
  onboard = tryCatchAsync(async (req: Request, res: Response) => {

    const { name, email, phone,domain,status, business_id, webhook_url, meta_config, settings, initial_credit} = req.body;
    const user = typeof req.body.user === 'string'? JSON.parse(req.body.user): req.body.user;

    const file = req.file

    let logo = null

    if(file){
      logo = file.filename
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
      initial_credit,
      user,
      logo
    });

    if(result){
      await sendEmail(
        email,
       'Welcome to Our Platform',
       `Hi ${name},\n\nWelcome to our platform! Your account has been created successfully. You can now log in using your Email: ${email} or Phone: ${phone}.\n\nBest regards,\nThe Soft 7 Team`,
      )
    }

    return successResponse(req, res, 'Company and user created successfully', result, HttpStatusCode.CREATED);
  });

  getCompanyDetails = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const companyDetails = await companyService.getCompanyDetails(req.companyId!)
    return successResponse(req,res,"Company Retrived successfully",companyDetails,HttpStatusCode.ACCEPTED)
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

  getUserStats = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
      console.log("User Id",req.userId!)
      const{time_frame} = req.query
      const userStats = await MessageService.getUserStats(req.userId!,time_frame)
      return successResponse(req,res, 'User Stats retrieved successfully', userStats)
  })

  getUserDetails = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    // console.log("User Id",req.userId!)
    const{userId} = req.params
    const userStats = await CompanyService.getUserStats(userId)
    return successResponse(req,res, 'User Stats retrieved successfully', userStats)
  })


  /**
   * GET /v1/companies
   * Get all companies
   */
  getAll = tryCatchAsync(async (req: Request, res: Response) => {
    const companies = await CompanyService.getAllCompanies();
    return successResponse(req, res, 'Companies retrieved successfully', companies);
  });

  /**
   * PUT /v1/companies/:id
   * Update company
   */
  updateCompany = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    let data = req.body
    const file = req.file
    if(file){
      data.logo = file.filename
    }
    const company = await CompanyService.updateCompany(req.companyId!, data);
    return successResponse(req, res, 'Company updated successfully', company);
  });

  /**
   * DELETE /v1/companies/:id
   * Delete company
   */
  deleteCompany = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    await CompanyService.deleteCompany(req.companyId!);
    return successResponse(req, res, 'Company deleted successfully');
  });

  /**
   * POST /v1/companies/user
   * Create user under company
   */
  createUser = tryCatchAsync(async(req: AuthRequest,res:Response)=>{
    const { name, email, phone, password, role,assigned_plan} = req.body;
    // console.log("Creating user with data:",{name,email,phone,role})

    if (!name || !email || !password) {
      throw new HTTP400Error({ message: 'Name, email, and password are required' });
    }

    const createdUser = await CompanyService.createUser(req.companyId!,{name,email,phone,password,role,assigned_plan})
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

  getdashboardStats = tryCatchAsync(async(req:AuthRequest, res:Response)=>{
    console.log("Fetching dashboard stats for companyId:", req.companyId!); // Debug log
    const stats = await CompanyService.getDashboardStats(req.companyId!,req.userId!)
    return successResponse(req,res, 'Dashboard stats retrieved successfully', stats)
  })

  getAllUsers = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const {role} = req.query
    const filters={
      page: req.query.page,
      limit: req.query.limit,
    }
    console.log("Fetching users with role filter:", role) // Debug log
    const users = await CompanyService.getAllUsers(req.userId!,req.companyId!,role,filters)
    return successResponse(req,res, 'Users retrieved successfully', users)
  })

  // getAdminUsers = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
  //   const users = await CompanyService.getAllUsers(req.userId!,req.companyId!)
  //   const adminUsers = users.filter((user:any)=> user.role === 'admin')
  //   return successResponse(req,res, 'Admin users retrieved successfully', adminUsers)
  // })

  getUser = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const user = await CompanyService.getUserById(req.userId!)
    return successResponse(req,res, 'User retrieved successfully', user)
  })

  updateCompanyUser =  tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const { name, email, phone, permissions,assigned_plan} = req.body;
    const {id} = req.params
    
    const updatedUser = await CompanyService.updateCompanyUser(id,{name,email,phone,permissions,assigned_plan})

    return successResponse(req,res, 'User updated successfully', updatedUser)
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

  async getUserPlan(req:AuthRequest,res:Response){
    const{userId} = req.params
    console.log("UserId",userId)
    const userPlan = await userPlansModel.getUserPlan(userId)
    if(!userPlan){
      return successResponse(req,res, 'No active plan for user', null)
    }
    return successResponse(req,res, 'User plan retrieved successfully', userPlan)
  }

async checkUserPlanStatus(req: AuthRequest, res: Response) {
  try {
    console.log("Checking user plan status for userId:", req.userId!)

    const userPlan = await userPlansModel.getUserPlan(req.userId!)
    if(!userPlan){
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
  
  async getUserById(req:AuthRequest,res:Response){
    const {userId} = req.params
    const user = await CompanyService.getUserById(userId)
    return successResponse(req,res,"User retrieved successfully",user)
  }

  async deleteCompanyUser(req:AuthRequest,res:Response){
    const {id} = req.params
    const deleteUser = await CompanyService.deleteUserById(id)
    return successResponse(req, res, 'Company User deleted successfully',deleteUser);
  }

  async getReminders(req:AuthRequest,res:Response){
    return successResponse(req,res,"No reminder for now",HttpStatusCode.OK)
  }

  async getCompaniesSubscription(req:AuthRequest,res:Response){
    const filters={
      page: req.query.page,
      limit: req.query.limit,
    }
    const companySubscriptions = await companyService.getcompanySubscriptions(req.userId!,req.companyId!,filters)
    return successResponse(req,res,"Company User Active subscriptions plans",companySubscriptions,HttpStatusCode.OK)
  }

  async updateUser(req: Request, res: Response) {
    const { id } = req.params;
    const company = await CompanyService.updateUser(id, req.body);
    return successResponse(req, res, 'Company updated successfully', company);
  };

  async suspendUser(req:Request,res:Response){
    const {id} = req.params
    const suspendUser = await CompanyService.suspendUser(id)
    successResponse(req,res,'User Suspend Successfully',suspendUser,HttpStatusCode.CREATED)
   }


  // async updateCompanyUser(req:AuthRequest,res:Response){
  //   const 
  // }
}

export default new CompanyController();
