import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import AuthService from '@surefy/console/services/auth.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import companyController from './company.controller';
import companyService from '../../services/company.service';
import sendEmail from '../../utils';
import activityLogsModel from '../../models/activityLogs.model';

export interface JWTRequest extends Request {
  userId?: string;
  userRole?: string;
  companyId?: string;
}

class AuthController {
  /**
   * POST /v1/auth/login
   * Login with email or phone
   */
  login = tryCatchAsync(async (req: Request, res: Response) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      throw new HTTP400Error({ message: 'Identifier (email or phone) and password are required' });
    }

    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '';

    const result = await AuthService.login({ identifier, password }, ipAddress);
    const{data}:any = result
    
    await activityLogsModel.create({
      user_id: data?.user.id,
      company_id:data?.company_id,
      action: 'LOGIN',
      entity_type: 'AUTH',
      description: 'User logged in successfully',
      ip_address: ipAddress,
      request_method: 'POST',
      api_endpoint: '/auth/login',
      status: 'SUCCESS'
    })

    return successResponse(req, res, 'Login successful', result);
  });

  /**
   * POST /v1/auth/forgot-password
   */
  // forgetPassword = tryCatchAsync(async(req:Request, res:Response) => {
  //   const{email} = req.body;

  //   if(!email){
  //     throw new HTTP400Error({message: 'Email is required'})
  //   }

  //   const 
  // })

  /**
   * POST /v1/auth/verify-otp
   * VERIFY OTP for password Reset
   */
  sendOtp = tryCatchAsync(async(req:Request,res:Response)=>{
    const {email} = req.body;
    if(!email){
      throw new HTTP400Error({message: 'Email is required'})  
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const verifyOtp = await AuthService.sendOtp(email,otp)
    return successResponse(req,res,`OTP sent successfully to ${email}`, verifyOtp)
  })

  /**
   * POST /v1/verify-otp
   * Verify OTP for password reset
   */
  verifyOtp = tryCatchAsync(async(req:Request,res:Response)=>{
    const {email,otp} = req.body;

    if(!otp && !email){
      throw new HTTP400Error({message: 'OTP and email are required'})  
    }

    const verifyOtp = await AuthService.verifyOtp(otp,email)
    return successResponse(req,res,'OTP verified successfully', verifyOtp)
  })
  

  /**
   * POST /v1/companies
   * Onboard new company
   */
  onboard = tryCatchAsync(async (req: Request, res: Response) => {
    const { name, email, phone, user } = req.body;
    console.log('Onboarding company with data:', { name, email, phone, user });

    if (!name || !email) {
      throw new HTTP400Error({ message: 'Name and email are required' });
    }

    if (!user || !user.name || !user.password || (!user.email && !user.phone)) {
      throw new HTTP400Error({
        message: 'User details are required: name, password, and either email or phone',
      });
    }

    const result = await companyService.onboardCompany({
      name,
      email,
      phone,
      user,
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

  /**
   * POST /v1/auth/register-company
   * Register new company along with admin user
   */

  /**
   * POST /v1/auth/register
   * Register new company user
   */
  register = tryCatchAsync(async (req: Request, res: Response) => {
    const { name, email, phone, password } = req.body; 
    // const permissions = ["dashboard", "inbox", "contact", "campaigns", "integrations", "manage", "gallery", "faq bot", "chatbot", "ai assistant", "flows", "developers", "reminder", "settings","templates","whatsapp-flows","chatbot","knowledge-base"]

    if (!name || !password) {
      throw new HTTP400Error({ message: 'Name and password are required' });
    }

    if (!email && !phone) {
      throw new HTTP400Error({ message: 'Either email or phone is required' });
    }

    const user = await AuthService.register({
      name,
      email,
      phone,
      password,
      role: 'user'
    });

    // if(user){
    //   await sendEmail(
    //     email,
    //    'Welcome to Our Platform',
    //    `Hi ${name},\n\nWelcome to our platform! Your account has been created successfully. You can now log in using your Email: ${email} or Phone: ${phone}.\n\nBest regards,\nThe Soft 7 Team`,
    //   )
    // }

    return successResponse(req, res, 'User registered successfully', user, HttpStatusCode.CREATED);
  });

  /**
   * POST /v1/auth/create-admin
   * Create admin/superadmin user (superadmin only)
   */
  createAdmin = tryCatchAsync(async (req: JWTRequest, res: Response) => {
    const { name, email, phone, password, role, company_id } = req.body;

    if (!name || !password || !role) {
      throw new HTTP400Error({ message: 'Name, password, and role are required' });
    }

    if (!email && !phone) {
      throw new HTTP400Error({ message: 'Either email or phone is required' });
    }

    if (role !== 'admin' && role !== 'superadmin') {
      throw new HTTP400Error({ message: 'Role must be either admin or superadmin' });
    }

    const user = await AuthService.createAdminUser(
      {
        name,
        email,
        phone,
        password,
        role,
        company_id,
      },
      req.userId!,
      req.userRole!,
    );

    return successResponse(req, res, `${role} user created successfully`, user, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/auth/profile
   * Get current user profile
   */
  getProfile = tryCatchAsync(async (req: JWTRequest, res: Response) => {
    const result = await AuthService.getProfile(req.userId!);
    return successResponse(req, res, 'Profile retrieved successfully', result);
  });

  /**
   * POST /v1/auth/change-password
   * Change user password
   */
  changePassword = tryCatchAsync(async (req: JWTRequest, res: Response) => {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      throw new HTTP400Error({ message: 'Current password and new password are required' });
    }

    if (new_password.length < 6) {
      throw new HTTP400Error({ message: 'New password must be at least 6 characters long' });
    }

    const result = await AuthService.changePassword(req.userId!, current_password, new_password);

    return successResponse(req, res, result.message);
  });

  async forgotPassword(req:Request,res:Response){
    const{token, newPassword} = req.body;
    const result = await AuthService.resetPassword(token,newPassword)
    return successResponse(req, res, 'Password reset successfully', result);
  }
}

export default new AuthController();
