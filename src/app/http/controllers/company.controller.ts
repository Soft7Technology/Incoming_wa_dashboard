import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import CompanyService from '@surefy/console/services/company.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import subscriptionModel from '@surefy/console/models/subscription.model'
import userPlansModel from '../../models/userPlans.model';

class CompanyController {
  /**
   * POST /v1/companies
   * Onboard new company
   */
  onboard = tryCatchAsync(async (req: Request, res: Response) => {
    const { name, email, phone,domain,status, business_id, webhook_url, meta_config, settings, initial_credit, user } = req.body;

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
    });

    return successResponse(req, res, 'Company and user created successfully', result, HttpStatusCode.CREATED);
  });

  // asyn

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
    const userStats = await CompanyService.getUserStats(req.userId!)
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
  update = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const company = await CompanyService.updateCompany(id, req.body);
    return successResponse(req, res, 'Company updated successfully', company);
  });

  /**
   * DELETE /v1/companies/:id
   * Delete company
   */
  delete = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await CompanyService.deleteCompany(id);
    return successResponse(req, res, 'Company deleted successfully');
  });

  /**
   * POST /v1/companies/user
   * Create user under company
   */
  createUser = tryCatchAsync(async(req: AuthRequest,res:Response)=>{
    const { name, email, phone, password, role,permissions} = req.body;
    // console.log("Creating user with data:",{name,email,phone,role})

    if (!name || !email || !password) {
      throw new HTTP400Error({ message: 'Name, email, and password are required' });
    }

    const createdUser = await CompanyService.createUser(req.companyId!,{name,email,phone,password,role,permissions})
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
    const users = await CompanyService.getAllUsers(req.companyId!,role)
    return successResponse(req,res, 'Users retrieved successfully', users)
  })

  getAdminUsers = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const users = await CompanyService.getAllUsers(req.companyId!)
    const adminUsers = users.filter((user:any)=> user.role === 'admin')
    return successResponse(req,res, 'Admin users retrieved successfully', adminUsers)
  })

  getUser = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const user = await CompanyService.getUserById(req.userId!)
    return successResponse(req,res, 'User retrieved successfully', user)
  })

  updateCompanyUser =  tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const { name, email, phone, permissions} = req.body;
    const {id} = req.params
    const updatedUser = await CompanyService.updateCompanyUser(id,{name,email,phone,permissions})
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
    return successResponse(req,res, 'User plan retrieved successfully', userPlan)
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

  async companyStats(req:AuthRequest,res:Response){
    //  const{id} = req
  }

  async getReminders(req:AuthRequest,res:Response){
    return successResponse(req,res,"No reminder for now",HttpStatusCode.OK)
  }

  // async updateCompanyUser(req:AuthRequest,res:Response){
  //   const 
  // }
}

export default new CompanyController();
