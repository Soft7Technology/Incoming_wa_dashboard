import CompanyRepository from '@surefy/console/repository/company.repository';
import { CreateCompanyDto, UpdateCompanyDto } from '@surefy/console/interfaces/company.interface';
import { generateCompanyKey } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import AuthService from './auth.service';
import userModel from '../models/user.model';
import companyModel from '../models/company.model';
import subscriptionModel from '../models/subscription.model';
import userPlansModel from '../models/userPlans.model';
import { transformFeatures } from '../utils';
import subscriptionService from './subscription.service';
import { sub } from 'date-fns';
import {uploadImage} from '@surefy/config/firebase.config'

class CompanyService {
  /**
   * Onboard new company with initial user
   */
  async onboardCompany(data: CreateCompanyDto) {
    // Check if email already exists
    console.log("Data",data)
    const existingCompany = await CompanyRepository.findByEmail(data.email);
    if (existingCompany) {
      throw new HTTP400Error({ message: 'Company with this email already exists' });
    }

    // Extract user data before creating company
    const userData = data.user;
    const { user, ...companyData } = data;

    // Create company (without user field)
    const company = await CompanyRepository.create(companyData);

    // Generate company key for secure authentication
    const companyKey = generateCompanyKey(company.id, process.env.API_KEY_SALT || '');

    // Create initial user if user data is provided
    let createdUser = null;
    if (userData) {
      createdUser = await AuthService.register({
        name: userData.name,
        company_id: company.id,
        email: userData.email,
        phone: userData.phone,
        password: userData.password,
        role: 'admin',
      });
    }

    const freePlan = await subscriptionModel.createFreePlan(createdUser.id, company.id);

    // Return company with key and user (only returned once during onboarding)
    return {
      company: {
        ...company,
      },
      user: createdUser,
      apiKey: company.api_key,
      companyKey: companyKey,
      freePlan: freePlan,
    };
  }

  async getCompanyDetails(companyId:string){
    const companyDetails = await companyModel.findById(companyId)
    return companyDetails
  }

  /**
   * Get Notification Stats for User
   */
  // async getNotificationStats(userId: string) {
  //   const stats = await userModel.getNotificationStats(userId);
  //   return stats;
  // }

  /**
   * Get company details
   */
  async getCompanyById(id: string) {
    const company = await CompanyRepository.findById(id);
    if (!company) {
      throw new HTTP404Error({ message: 'Company not found' });
    }
    return company;
  }

  async getUserStats(userId: any) {
    const userStats = await CompanyRepository.getUserStats(userId);
    return userStats;
  }

  /**
   * Update company
   */
  async updateCompany(companyId:string, data: UpdateCompanyDto) {
    const company = await this.getCompanyById(companyId);
    if(company){
      return CompanyRepository.update(companyId, data);
    }
  }

  /**
   * Delete company
   */
  async deleteCompany(companyId: string) {
    await this.getCompanyById(companyId);
    return CompanyRepository.delete(companyId);
  }

  /**
   * Get all companies
   */
  async getAllCompanies(filters: any = {}) {
    return CompanyRepository.getAll(filters);
  }

  /**
   * Regenerate company API keys
   */
  async regenerateKeys(companyId: string, user: any) {
    // Authorization check
    if (user.role === 'company' && user.company_id !== companyId) {
      throw new HTTP403Error({ message: 'Unauthorized access to company credentials' });
    }

    // Get company details
    const company = await this.getCompanyById(companyId);

    // Generate company key using the same deterministic HMAC function
    const companyKey = generateCompanyKey(company.id, process.env.API_KEY_SALT || '');

    // Return both keys
    return {
      apiKey: company.api_key,
      companyKey: companyKey,
    };
  }

  async getDashboardStats(companyId: string, userId: string) {
    console.log('Fetching dashboard stats for companyId:', companyId); // Debug log
    const user = await userModel.findById(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }
    const stats = await companyModel.getDashboardStats(companyId, userId, user.role);
    return stats;
  }

  async getAllUsers(userId: string, companyId: string, role?: any) {
    console.log('Fetching users for companyId:', companyId, 'with role filter:', role); // Debug log
    const user = await userModel.findById(userId);

    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }
    const users = await userModel.findAllUserByCompanyId(companyId, user.role,role);
    return users;
  }

  async getUserById(userId: string) {
    const user = await userModel.findById(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    } else {
      return user;
    }
  }

  // async updateCompanyUser(userId: string, data: any) {
  //   const { assigned_plan } = data;

  //   //1. check if user have existing plans
  //   //2. check if user have exists subscription plan match the subscriptonPlanId === planId
  //   //3. if user have existingPlans want to add newPlan then calculate the existing days in the existing plan and in new plan to set endDate startDate

  //   const user = await userModel.findById(userId);
  //   if (!user) {
  //     throw new HTTP404Error({ message: 'User not found' });
  //   }

  //   // Handle assigned_plan update if provided
  //   if (assigned_plan) {
  //     const existingPlan = await userPlansModel.findPlanByUserId(userId);
  //     // Settle
  //     // if (existingPlan) {
  //     //   throw new HTTP400Error({ message: 'Active plan already exists for this user' });
  //     // }

  //     if (existingPlan && existingPlan.subscription_id === assigned_plan) {
  //       throw new HTTP400Error({ message: 'User is already assigned to this subscription plan' });
  //     }

  //     const subscriptionPlanDetails = assigned_plan ? await subscriptionModel.findPlans(assigned_plan, true) : null;

  //     if (assigned_plan && !subscriptionPlanDetails) {
  //       throw new HTTP400Error({ message: 'Assigned subscription plan not found or not active' });
  //     }

  //     let userPlan = null;

  //     if (!existingPlan) {
  //       userPlan = await this.activateUserPlan(userId, subscriptionPlanDetails);
  //     }

  //     if (existingPlan.billing_cycle !== 'Free' && subscriptionPlanDetails) {
  //       // Settle existing plan if it's not a free trial
  //       userPlan = await this.settleUserPlan(existingPlan.id, subscriptionPlanDetails, existingPlan, user.company_id);
  //     } else if (subscriptionPlanDetails || existingPlan.billing_cycle === 'Free') {
  //       //Assigned new plan if existing plan is free trial or new assigned plan is free trial
  //       userPlan = await this.activateUserPlan(userId, subscriptionPlanDetails);
  //     }
  //     console.log("UserPlan",userPlan)

  //     // 🔥 CRITICAL FIX
  //     if (userPlan) {
  //       data.assigned_plan = userPlan.id;
  //     }

  //     const updatedUserPlan = await userModel.update(userId, data);
  //     return updatedUserPlan;
  //   }

  //   const updatedUser = await userModel.update(userId, data);
  //   return updatedUser;
  // }

  async updateCompanyUser(userId: string, data: any) {
    const { assigned_plan } = data;

    const user = await userModel.findById(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }

    if (!assigned_plan) {
      return await userModel.update(userId, data);
    }

    // 1. Get existing plan
    const existingPlan = await userPlansModel.findPlanByUserId(userId);

    // 2. Prevent same plan reassignment
    if (existingPlan && existingPlan.subscription_id === assigned_plan) {
      throw new HTTP400Error({
        message: 'User is already assigned to this subscription plan',
      });
    }

    // 3. Get new plan details
    const subscriptionPlanDetails = await subscriptionModel.findPlans(assigned_plan, true);

    if (!subscriptionPlanDetails) {
      throw new HTTP400Error({
        message: 'Assigned subscription plan not found or not active',
      });
    }

    let userPlan = null;

    // =========================
    // 🎯 CASE HANDLING
    // =========================

    // ✅ Case 1: No existing plan
    if (!existingPlan) {
      userPlan = await this.activateUserPlan(userId, subscriptionPlanDetails, null, user.company_id);
    }

    // ✅ Case 2: Existing FREE plan → replace directly
    else if (existingPlan.billing_cycle === 'Free') {
      userPlan = await this.activateUserPlan(userId, subscriptionPlanDetails, existingPlan, user.company_id);
    }

    // ✅ Case 3: Existing PAID plan → settle (carry forward)
    else {
      userPlan = await this.settleUserPlan(existingPlan.id, subscriptionPlanDetails, existingPlan, user.company_id);
    }

    // =========================

    console.log('UserPlan', userPlan);

    if (userPlan) {
      data.assigned_plan = userPlan.id;
    }

    return await userModel.update(userId, data);
  }

  async createUserPlan(userId: string, companyId: string, planData: any, razorPayDetails: any) {
    const { plan_name, price, billing_cycle, features } = planData;

    const { limits, usage } = transformFeatures(features);
    console.log('Transformed limits:', limits);
    console.log('Transformed usage:', usage);

    const durationDays = billing_cycle === 'Monthly' ? 30 : billing_cycle === 'Yearly' ? 365 : 3;

    const startDate = new Date();

    const endDate = new Date(startDate);

    if (billing_cycle === 'Monthly') {
      endDate.setMonth(endDate.getMonth() + 1);
    } else if (billing_cycle === 'Yearly') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else if (billing_cycle === 'Free') {
      endDate.setDate(endDate.getDate() + 3);
    }

    const newUserPlan = await userPlansModel.create({
      user_id: userId,
      company_id: companyId,
      plan_name,
      price,
      billing_cycle,
      razorpayOrderId: razorPayDetails.id,
      status: 'pending',
      start_date: startDate,
      end_date: endDate,
      limits: JSON.stringify(limits), // JSONB
      usage: JSON.stringify(usage), // JSONB
      active: false,
      duration_days: durationDays,
    });
    return newUserPlan;
  }

  async activateUserPlan(userId: string, planData?: any, existingUserPlan?: any, companyId?: string) {
    console.log('Activing Plan', userId, planData);
    console.log('Existing User Plan:', existingUserPlan);
    if (!planData) {
      console.error('planData is undefined ❌');
      throw new Error('planData is required');
    }

    const { plan_name, price, billing_cycle, features } = planData;

    if (existingUserPlan) {
      await userPlansModel.update(existingUserPlan, { active: false });
    }

    const durationDays = billing_cycle === 'Monthly' ? 30 : billing_cycle === 'Yearly' ? 365 : 3;

    const { limits, usage } = transformFeatures(features);
    console.log('Transformed limits:', limits);
    console.log('Transformed usage:', usage);

    const startDate = new Date();

    const endDate = new Date(startDate);

    if (billing_cycle === 'Monthly') {
      endDate.setMonth(endDate.getMonth() + 1);
    } else if (billing_cycle === 'Yearly') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else if (billing_cycle === 'Free') {
      endDate.setDate(endDate.getDate() + 3);
    }

    const newUserPlan = await userPlansModel.create({
      user_id: userId,
      company_id: companyId,
      plan_name,
      price,
      billing_cycle,
      status: 'COMPLETED',
      start_date: startDate,
      end_date: endDate,
      subscription_id: planData.id,
      active: true,
      limits: JSON.stringify(limits), // JSONB
      usage: JSON.stringify(usage), // JSONB
      duration_days: durationDays,
    });

    await userModel.update(userId,{assigned_plan:newUserPlan.id})
    return newUserPlan;
  }

  //   async settleUserPlan(
  //   userPlanId: string,
  //   planData: any,
  //   existingUserPlan: any,
  //   companyId: string
  // ) {
  //   const now = new Date();

  //   // 1. Calculate remaining days
  //   const endDate = new Date(existingUserPlan.end_date);

  //   let remainingDays = 0;
  //   if (endDate > now) {
  //     remainingDays = Math.ceil(
  //       (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  //     );
  //   }

  //   // 2. Calculate remaining value from old plan
  //   const oldPlanDuration = existingUserPlan.duration_days;
  //   const oldPlanPrice = existingUserPlan.price;

  //   const oldPerDayPrice = oldPlanPrice / oldPlanDuration;
  //   const remainingValue = remainingDays * oldPerDayPrice;

  //   // 3. Convert value into new plan days
  //   const newPlanDuration = planData.duration_days;
  //   const newPlanPrice = planData.price;

  //   const newPerDayPrice = newPlanPrice / newPlanDuration;

  //   const extraDays = Math.floor(remainingValue / newPerDayPrice);

  //   const finalDays = newPlanDuration + extraDays;

  //   // 4. Deactivate old plan
  //   await userPlansModel.query().patch({
  //     is_active: false,
  //     ended_at: now,
  //   }).where({ id: userPlanId });

  //   // 5. Create new plan
  //   const newStartDate = now;
  //   const newEndDate = new Date();
  //   newEndDate.setDate(newEndDate.getDate() + finalDays);

  //   const newUserPlan = await userPlansModel.query().insert({
  //     user_id: existingUserPlan.user_id,
  //     company_id: companyId,
  //     subscription_id: planData.id,
  //     start_date: newStartDate,
  //     end_date: newEndDate,
  //     duration_days: finalDays,
  //     price: planData.price,
  //     is_active: true,
  //   });

  //   return newUserPlan;
  // }

  async settleUserPlan(userPlanId: string, planData: any, existingUserPlan: any, companyId: string) {
    const now = new Date();

    // Calculate remaining days
    const endDate = new Date(existingUserPlan.end_date);
    let remainingDays = 0;

    if (endDate > now) {
      remainingDays = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }

    const { limits, usage } = transformFeatures(planData.features);

    const finalDays =
      planData.billing_cycle === 'Monthly'
        ? 30 + remainingDays
        : planData.billing_cycle === 'Yearly'
          ? 365 + remainingDays
          : remainingDays;

    // ✅ Calculate end date
    const newEndDate = new Date(now);
    newEndDate.setDate(newEndDate.getDate() + finalDays);

    // (Optional but recommended) deactivate old plan
    await userPlansModel.update(existingUserPlan.id, { active: false, end_date: now });

    const newUserPlan = await userPlansModel.create({
      user_id: existingUserPlan.user_id,
      company_id: companyId,
      plan_name: planData.plan_name,
      price: planData.price,
      billing_cycle: planData.billing_cycle,
      status: 'COMPLETED',
      subscription_id: planData.id,
      active: true,
      limits: JSON.stringify(limits),
      usage: JSON.stringify(usage),
      start_date: now,
      end_date: newEndDate,
      duration_days: finalDays,
    });

    return newUserPlan;
  }

  async getcompanySubscriptions(userId: string, companyId: string,active:any) {
    const user = await userModel.findById(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }
    const companySubscritions = await userPlansModel.findCompanyActiveSubscriptions(userId, companyId, user.role, active);
    return companySubscritions;
  }

  /**
   * Create user under company
   */
  async createUser(
    companyId: string,
    userData: { name: string; email?: string; phone?: string; password: string; role: string; assigned_plan?: string },
  ) {
    const existingUser = await userModel.findByEmail(userData.email);

    if (existingUser) {
      throw new HTTP400Error({ message: 'User with this email already exists' });
    }

    if (!companyId) {
      throw new HTTP400Error({ message: 'Company ID is required to create user' });
    }

    // const newUserPlan = await this.createU

    let createdUser = null;
    if (userData) {
      createdUser = await AuthService.register({
        name: userData.name,
        company_id: companyId,
        email: userData.email,
        phone: userData.phone,
        password: userData.password,
        role: userData.role,
      });
    }

    //Company Subscription Plan
    // if (userData.assigned_plan) {
    //   const subscriptionPlanDetails = userData.assigned_plan
    //     ? await subscriptionModel.findPlans(userData.assigned_plan, true)
    //     : null;

    //   console.log('Subscription Plan Details:', subscriptionPlanDetails);
    //   if (!subscriptionPlanDetails) {
    //     throw new HTTP400Error({ message: 'Assigned subscription plan not found' });
    //   }
    //   const activatedUserPlan = await this.activateUserPlan(createdUser.id, subscriptionPlanDetails, companyId);
    //   if (!activatedUserPlan) {
    //     throw new HTTP400Error({ message: 'Failed to activate subscription plan for the user' });
    //   }
    //   await userModel.update(createdUser.id, { assigned_plan: activatedUserPlan.id });
    // }

    // if (subscriptionPlanDetails) {
    //   const activatedUserPlan = await this.activateUserPlan(createdUser.id, subscriptionPlanDetails, companyId);
    //   if (!activatedUserPlan) {
    //     throw new HTTP400Error({ message: 'Failed to activate subscription plan for the user' });
    //   }
    //   await userModel.update(createdUser.id, { assigned_plan: activatedUserPlan.id });
    // }

    return createdUser;
  }

  async deleteUserById(userId: string) {
    const deleteUser = await userModel.delete(userId);
    return deleteUser;
  }

  async updateUser(userId:string,data:string){
    const updateUser = await userModel.update(userId,data)
    return updateUser
  }

  async suspendUser(userId:string){
    const suspendUser = await userModel.update(userId,{status:'suspended'})
    return suspendUser
  }

  async activateUser(userId:string){
    const activateUser = await userModel.update(userId,{status:'active'})
    return activateUser
  }

  //   async createUser(
  //   companyId: string,
  //   userData: {
  //     name: string;
  //     email?: string;
  //     phone?: string;
  //     password: string;
  //     role: string;
  //     permissions?: string[]; // from frontend slider
  //   }
  // ) {
  //   // 1. Check existing user
  //   const existingUser = await userModel.findByEmail(userData.email);

  //   if (existingUser) {
  //     throw new HTTP400Error({ message: 'User with this email already exists' });
  //   }

  //   // 2. Create user
  //   const createdUser = await AuthService.register({
  //     name: userData.name,
  //     company_id: companyId,
  //     email: userData.email,
  //     phone: userData.phone,
  //     password: userData.password
  //   });

  //   // 3. Assign permissions (if provided)
  //   if (createdUser && userData.permissions?.length) {
  //     const permissionRows = userData.permissions.map((permId) => ({
  //       user_id: createdUser.id,
  //       permission_id: permId
  //     }));

  //     await knex('user_permissions')
  //       .insert(permissionRows)
  //       .onConflict(['user_id', 'permission_id'])
  //       .ignore();
  //   }

  //   return createdUser;
  // }
}

export default new CompanyService();
