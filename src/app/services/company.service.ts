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
import { uploadImage } from '@surefy/config/firebase.config'
import creditTransactionModel from '../models/creditTransaction.model';
import activityLogsModel from '../models/activityLogs.model';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';
import { now } from 'lodash';

class CompanyService {
  /**
   * Onboard new company with initial user
   */
  async onboardCompany(data: CreateCompanyDto) {
    // Check if email already exists
    console.log("Data", data)
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

  async getCompanyDetails(companyId: string) {
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
  async updateCompany(companyId: string, data: UpdateCompanyDto) {
    const company = await this.getCompanyById(companyId);
    if (company) {
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
  async getAllCompanies(filters: any) {
    return CompanyRepository.getAllCompanies(filters);
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

  async getAllUsers(userId: string, companyId: string, filters?: any) {
    console.log('Fetching users for companyId:', companyId, 'with role filter:', filters); // Debug log
    const user = await userModel.findById(userId);

    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }
    const users = await userModel.findAllUserByCompanyId(companyId, filters);
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

    console.log("User",user)

    if (!assigned_plan) {
      return await userModel.update(userId, data);
    }

    // 1. Get existing plan
    const existingPlan = await userPlansModel.findUserPlan(user.assigned_plan);
    console.log("Existing Plan",existingPlan)

    // 2. Prevent same plan reassignment
    if (existingPlan && existingPlan.subscription_id === assigned_plan) {
      throw new HTTP400Error({
        message: 'User is already assigned to this subscription plan',
      });
    }

    // 3. Get new plan details
    const subscriptionPlanDetails = await subscriptionModel.findPlans(assigned_plan, true);
    console.log("Subscruption", subscriptionPlanDetails)

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
      userPlan = await this.activateUserPlan(userId, user, subscriptionPlanDetails, null);
    }

    // ✅ Case 2: Existing FREE plan → replace directly
    else if (existingPlan.billing_cycle === 'Free') {
      userPlan = await this.activateUserPlan(userId, user, subscriptionPlanDetails, existingPlan);
    }

    // ✅ Case 3: Existing PAID plan → settle (carry forward)
    else {
      userPlan = await this.settleUserPlan(existingPlan.id, user, subscriptionPlanDetails, existingPlan);
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

  // if its monthly so from company credit_balance price of the subscription will get cut 
  // commission to the superAdmin of 1000 on yearly and 100 on monthly 
  // where debit of prices from company balance and in superadmin balance will add the comission of 100 and 1000 ruppes based upon the mothly yearly


  async activateUserPlan(
    userId: string,
    user: any,
    planData: any,
    existingUserPlan?: any,
  ) {
    console.log("User", user)
    if (!planData) {
      throw new Error('planData is required');
    }

    const { plan_name, price, billing_cycle, features } = planData;
    console.log("Plan Data", planData)

    console.log('User:', userId, 'Company:', user.company_id);

    // =====================================================
    // COMPANY VALIDATION
    // =====================================================

    const companyDetails = await companyModel.findById(user.company_id);

    if (!companyDetails) {
      // =====================================================
      // PLAN DATES
      // =====================================================

      const durationDays =
        billing_cycle === 'Monthly'
          ? 30
          : billing_cycle === 'Yearly'
            ? 365
            : 3;

      const { limits, usage } =
        transformFeatures(features);

      const startDate = new Date();
      const endDate = new Date(startDate);

      if (billing_cycle === 'Monthly') {
        endDate.setMonth(endDate.getMonth() + 1);
      } else if (billing_cycle === 'Yearly') {
        endDate.setFullYear(endDate.getFullYear() + 1);
      } else {
        endDate.setDate(endDate.getDate() + 3);
      }

      // =====================================================
      // CREATE USER PLAN
      // =====================================================

      const superAdmin: any =
        await userModel.findSuperAdmin('superadmin');

      console.log("Superadmin", superAdmin)

      if (!superAdmin) {
        throw new HTTP400Error({
          message: 'Super admin not found',
        });
      }

      const balanceBefore =
        Number(superAdmin.credit_balance || 0);

      console.log("Balance bfore", balanceBefore)

      const balanceAfter =
        balanceBefore + Number(price);

      await userModel.update(superAdmin.id, {
        credit_balance: balanceAfter,
      });

      // Credit Transaction
      await creditTransactionModel.create({
        user_id: superAdmin.id,
        company_id: superAdmin.company_id,
        type: 'credit',
        amount: Number(price),
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        description: `Subscription purchase (${plan_name}) without company`,
        created_by: userId,
        reference_type: 'subscription',
      });

      // Activity Log
      await activityLogsModel.create({
        user_id: superAdmin.id,
        company_id: superAdmin.company_id,

        action: 'CREDIT',
        entity_type: 'WALLET',
        entity_id: superAdmin.id,

        read: false,

        description: `₹${price} credited from subscription purchase (${plan_name})`,

        new_data: {
          plan_name,
          price,
          balance_before: balanceBefore,
          balance_after: balanceAfter,
        },

        status: 'SUCCESS',
      });

      const newUserPlan = await userPlansModel.create({
        user_id: userId,
        company_id: user.company_id,
        plan_name,
        price,
        billing_cycle,

        status: 'COMPLETED',

        start_date: startDate,
        end_date: endDate,

        subscription_id: planData.id,

        active: true,

        limits: JSON.stringify(limits),
        usage: JSON.stringify(usage),

        duration_days: durationDays,
      });

      return newUserPlan
    }

    // =====================================================
    // COMMISSION CALCULATION
    // =====================================================

    let commission = 0;

    if (billing_cycle === 'Monthly') {
      commission = 100.00;
    } else if (billing_cycle === 'Yearly') {
      commission = 1000.00;
    }

    const subscriptionAmount = Number(price);
    const totalDeduction = commission;

    const companyBalanceBefore = Number(
      companyDetails.credit_balance || 0
    );

    if (companyBalanceBefore < commission) {
      throw new HTTP400Error({
        message: `Insufficient company wallet balance. Required ₹${totalDeduction}`,
      });
    }

    const companyBalanceAfter =
      companyBalanceBefore - commission;

    // =====================================================
    // DEBIT COMPANY WALLET
    // =====================================================

    await companyModel.update(user.company_id, {
      credit_balance: companyBalanceAfter,
    });

    // =====================================================
    // COMPANY TRANSACTION - SUBSCRIPTION DEBIT
    // =====================================================

    const balanceAfterSubscription =
      companyBalanceBefore - subscriptionAmount;

    // await creditTransactionModel.create({
    //   company_id: companyId,
    //   user_id: userId,
    //   company_name:
    //     companyDetails.company_name || companyDetails.name,

    //   type: 'debit',
    //   amount: subscriptionAmount,

    //   balance_before: companyBalanceBefore,
    //   balance_after: balanceAfterSubscription,

    //   description: `Subscription plan (${plan_name}) assigned to ${userId}`,

    //   created_by: userId,
    //   reference_type: 'subscription',
    // });

    // =====================================================
    // COMPANY TRANSACTION - COMMISSION DEBIT
    // =====================================================

    if (commission > 0) {
      await creditTransactionModel.create({
        company_id: user.company_id,
        user_id: userId,
        company_name:
          companyDetails.company_name || companyDetails.name,

        type: 'debit',
        amount: -commission,

        balance_before: balanceAfterSubscription,
        balance_after: companyBalanceAfter,

        description: `${commission} platform fee  transferred to Soft7`,

        created_by: userId,
        reference_type: 'subscription_commission',
      });

      await activityLogsModel.create({
        user_id: userId,
        company_id: user.company_id,

        action: 'DEBIT',
        entity_type: 'WALLET',
        entity_id: user.company_id,

        read: false,

        description: `₹${commission} Platform fee deducted from company wallet`,

        new_data: {
          commission,
          billing_cycle,
          balance_before: balanceAfterSubscription,
          balance_after: companyBalanceAfter,
        },

        status: 'SUCCESS',
      });
    }

    // =====================================================
    // SUPER ADMIN COMMISSION CREDIT
    // =====================================================

    if (commission > 0) {
      const superAdmin: any =
        await userModel.findSuperAdmin('superadmin');

      if (superAdmin) {
        const superAdminBalanceBefore = Number(
          superAdmin.credit_balance || 0
        );

        const superAdminBalanceAfter =
          superAdminBalanceBefore + commission;

        await userModel.update(superAdmin.id, {
          credit_balance: superAdminBalanceAfter,
        });

        await creditTransactionModel.create({
          user_id: superAdmin.id,
          company_id: superAdmin.company_id,

          type: 'credit',
          amount: commission,

          balance_before: superAdminBalanceBefore,
          balance_after: superAdminBalanceAfter,

          description: `Platform fee received from ${companyDetails.company_name || companyDetails.name
            } for assiging ${plan_name} to ${user.name}`,

          created_by: userId,
          reference_type: 'subscription_commission',
        });

        await activityLogsModel.create({
          user_id: superAdmin.id,
          company_id: superAdmin.company_id,

          action: 'CREDIT',
          entity_type: 'WALLET',
          entity_id: superAdmin.id,

          read: false,

          description: `₹${commission} Platform fee received from ${companyDetails.company_name || companyDetails.name
            }`,

          new_data: {
            commission,
            source_company:
              companyDetails.company_name ||
              companyDetails.name,

            balance_before: superAdminBalanceBefore,
            balance_after: superAdminBalanceAfter,
          },

          status: 'SUCCESS',

        });
      }
    }

    // =====================================================
    // DEACTIVATE OLD PLAN
    // =====================================================
    const now = new Date();

    if (existingUserPlan) {
      console.log("Existsing Plan",existingUserPlan)
      await userPlansModel.update(existingUserPlan.id, {
        active: false,
        status:'EXPIRED',
        end_date: now,
      });
    }

    // =====================================================
    // PLAN DATES
    // =====================================================

    const durationDays =
      billing_cycle === 'Monthly'
        ? 30
        : billing_cycle === 'Yearly'
          ? 365
          : 3;

    const { limits, usage } =
      transformFeatures(features);

    const startDate = new Date();
    const endDate = new Date(startDate);

    if (billing_cycle === 'Monthly') {
      endDate.setMonth(endDate.getMonth() + 1);
    } else if (billing_cycle === 'Yearly') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setDate(endDate.getDate() + 3);
    }

    // =====================================================
    // CREATE USER PLAN
    // =====================================================

    const newUserPlan = await userPlansModel.create({
      user_id: userId,
      company_id: user.company_id,
      plan_name,
      price,
      billing_cycle,

      status: 'COMPLETED',

      start_date: startDate,
      end_date: endDate,

      subscription_id: planData.id,

      active: true,

      limits: JSON.stringify(limits),
      usage: JSON.stringify(usage),

      duration_days: durationDays,
    });

    // =====================================================
    // ASSIGN PLAN TO USER
    // =====================================================

    await userModel.update(userId, {
      assigned_plan: newUserPlan.id,
    });

    // =====================================================
    // PLAN ACTIVATION ACTIVITY
    // =====================================================

    await activityLogsModel.create({
      user_id: userId,
      company_id: user.company_id,

      action: 'ACTIVATE',
      entity_type: 'SUBSCRIPTION',
      entity_id: newUserPlan.id,

      read: false,

      description: `${plan_name} plan activated (${billing_cycle}) for ₹${price}`,

      new_data: {
        id: newUserPlan.id,
        plan_name: newUserPlan.plan_name,
        billing_cycle: newUserPlan.billing_cycle,
        price: newUserPlan.price,

        commission,

        total_deduction: totalDeduction,

        start_date: newUserPlan.start_date,
        end_date: newUserPlan.end_date,

        active: true,
      },

      status: 'SUCCESS',
    });

    return newUserPlan;
  }


  async settleUserPlan(
    userPlanId: string,
    user: any,
    planData: any,
    existingUserPlan: any,
  ) {
    const now = new Date();
    console.log("Settle Plan",user)

    const { plan_name, price, billing_cycle, features } = planData;

    // =====================================================
    // COMPANY VALIDATION
    // =====================================================

    const companyDetails = await companyModel.findById(user.company_id);

    if (!companyDetails) {
      throw new HTTP400Error({
        message: 'Company not found',
      });
    }

    // =====================================================
    // COMMISSION CALCULATION
    // =====================================================

    let commission = 0;

    if (billing_cycle === 'Monthly') {
      commission = 100.00;
    } else if (billing_cycle === 'Yearly') {
      commission = 1000.00;
    }

    const companyBalanceBefore = Number(
      companyDetails.credit_balance || 0
    );

    if (companyBalanceBefore < commission) {
      throw new HTTP400Error({
        message: `Insufficient company wallet balance. Required ₹${commission}`,
      });
    }

    const companyBalanceAfter =
      companyBalanceBefore - commission;

    // =====================================================
    // DEBIT COMPANY WALLET (ONLY COMMISSION)
    // =====================================================

    await companyModel.update(companyDetails.id, {
      credit_balance: companyBalanceAfter,
    });

    // =====================================================
    // COMPANY COMMISSION TRANSACTION
    // =====================================================

    if (commission > 0) {
      await creditTransactionModel.create({
        company_id: user.company_id,
        user_id: existingUserPlan.user_id,
        company_name:
          companyDetails.company_name || companyDetails.name,

        type: 'debit',
        amount: - commission,

        balance_before: companyBalanceBefore,
        balance_after: companyBalanceAfter,

        description: `Platform fee deducted for plan upgrade (${existingUserPlan.plan_name} → ${plan_name}) for ${billing_cycle}`,

        created_by: existingUserPlan.user_id,
        reference_type: 'subscription_commission',
      });

      await activityLogsModel.create({
        user_id: existingUserPlan.user_id,
        company_id: user.company_id,

        action: 'DEBIT',
        entity_type: 'WALLET',
        entity_id: user.companyId,

        read: false,

        description: `Platform fee deducted for upgrading ${existingUserPlan.plan_name}- ${existingUserPlan.billing_cycle} to ${plan_name}-${billing_cycle}`,

        new_data: {
          old_plan: existingUserPlan.plan_name,
          new_plan: plan_name,
          commission,
          balance_before: companyBalanceBefore,
          balance_after: companyBalanceAfter,
        },

        status: 'SUCCESS',
      });
    }

    // =====================================================
    // SUPER ADMIN COMMISSION CREDIT
    // =====================================================

    if (commission > 0) {
      const superAdmin: any =
        await userModel.findSuperAdmin('superadmin');

      if (superAdmin) {
        const superAdminBalanceBefore = Number(
          superAdmin.credit_balance || 0
        );

        const superAdminBalanceAfter =
          superAdminBalanceBefore + commission;

        await userModel.update(superAdmin.id, {
          credit_balance: superAdminBalanceAfter,
        });

        await creditTransactionModel.create({
          user_id: superAdmin.id,
          company_id: superAdmin.company_id,

          type: 'credit',
          amount: commission,

          balance_before: superAdminBalanceBefore,
          balance_after: superAdminBalanceAfter,

          description: `Platform fee received for upgrade (${existingUserPlan.plan_name} → ${plan_name}) from ${companyDetails.company_name || companyDetails.name
            }`,

          created_by: existingUserPlan.user_id,
          reference_type: 'subscription_commission',
        });

        await activityLogsModel.create({
          user_id: superAdmin.id,
          company_id: superAdmin.company_id,

          action: 'CREDIT',
          entity_type: 'WALLET',
          entity_id: superAdmin.id,

          read: false,

          description: `Platform fee received for plan upgrade (${existingUserPlan.plan_name} → ${plan_name})`,

          new_data: {
            source_company:
              companyDetails.company_name ||
              companyDetails.name,

            old_plan: existingUserPlan.plan_name,
            new_plan: plan_name,

            commission,

            balance_before: superAdminBalanceBefore,
            balance_after: superAdminBalanceAfter,
          },

          status: 'SUCCESS',
        });
      }
    }

    // =====================================================
    // CALCULATE REMAINING DAYS
    // =====================================================

    const currentEndDate = new Date(
      existingUserPlan.end_date
    );

    let remainingDays = 0;

    if (currentEndDate > now) {
      remainingDays = Math.ceil(
        (currentEndDate.getTime() - now.getTime()) /
        (1000 * 60 * 60 * 24)
      );
    }

    // =====================================================
    // FEATURE TRANSFORMATION
    // =====================================================

    const { limits, usage } =
      transformFeatures(features);

    const finalDays =
      billing_cycle === 'Monthly'
        ? 30 + remainingDays
        : billing_cycle === 'Yearly'
          ? 365 + remainingDays
          : remainingDays;

    // =====================================================
    // CALCULATE NEW END DATE
    // =====================================================

    const newEndDate = new Date(now);
    newEndDate.setDate(
      newEndDate.getDate() + finalDays
    );

    // =====================================================
    // DEACTIVATE OLD PLAN
    // =====================================================

    await userPlansModel.update(existingUserPlan.id, {
      active: false,
      end_date: now,
    });

    // =====================================================
    // CREATE NEW PLAN
    // =====================================================

    const newUserPlan = await userPlansModel.create({
      user_id: existingUserPlan.user_id,
      company_id: user.companyId,

      plan_name,
      price,
      billing_cycle,

      status: 'COMPLETED',

      subscription_id: planData.id,

      active: true,

      limits: JSON.stringify(limits),
      usage: JSON.stringify(usage),

      start_date: now,
      end_date: newEndDate,

      duration_days: finalDays,
    });

    // =====================================================
    // UPDATE ASSIGNED PLAN
    // =====================================================

    await userModel.update(existingUserPlan.user_id, {
      assigned_plan: newUserPlan.id,
    });

    // =====================================================
    // PLAN UPGRADE ACTIVITY
    // =====================================================

    await activityLogsModel.create({
      user_id: existingUserPlan.user_id,
      company_id: user.companyId,

      action: 'UPGRADE',
      entity_type: 'SUBSCRIPTION',
      entity_id: newUserPlan.id,

      read: false,

      description: `Plan upgraded from ${existingUserPlan.plan_name} to ${plan_name} (${billing_cycle})`,

      new_data: {
        id: newUserPlan.id,

        old_plan: existingUserPlan.plan_name,
        new_plan: plan_name,

        billing_cycle,
        price,

        commission,

        start_date: newUserPlan.start_date,
        end_date: newUserPlan.end_date,

        remaining_days_carried: remainingDays,

        active: true,
      },

      status: 'SUCCESS',
    });

    return newUserPlan;
  }

  async getcompanySubscriptions(userId: string, companyId: string, active: any) {
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

    return createdUser;
  }

  async deleteUserById(userId: string) {
    const deleteUser = await userModel.delete(userId);
    return deleteUser;
  }

  async updateUser(userId: string, data: string) {
    const updateUser = await userModel.update(userId, data)
    return updateUser
  }

  async resetUserPassword(userId: string, newPassword: string) {
    const user = await userModel.findById(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }

    const hashedPassword = await AuthService.hashPassword(newPassword);
    const updatedUser = await userModel.changePassword(userId, hashedPassword);
    return updatedUser;
  }

  async suspendUser(userId: string) {
    const suspendUser = await userModel.update(userId, { status: 'suspended' })
    return suspendUser
  }

  async activateSingleUser(userId: string) {
    const activatedUser = await userModel.update(userId, { status: 'active' });
    return activatedUser;
  }

  async inctiveSingleUser(userId: string) {
    const inactiveUser = await userModel.update(userId, { status: 'inactive' });
    return inactiveUser;
  }

  async activateUser(companyId: string) {
    const companyUser = await userModel.findCompanyUsers(companyId)
    if (!companyUser) {
      throw new HTTP401Error({ message: "Company not have any active user" })
    }

    for (const user of companyUser) {
      await userModel.update(user.id, { status: "active" })
    }

    const activeCompany = await companyModel.update(companyId, { status: "active" })
    return activeCompany
  }


  async inactiveUser(companyId: string) {
    const companyUser = await userModel.findCompanyUsers(companyId)
    if (!companyUser) {
      throw new HTTP401Error({ message: "Company not have any active user" })
    }

    for (const user of companyUser) {
      await userModel.update(user.id, { status: "inactive" })
    }

    const activeCompany = await companyModel.update(companyId, { status: "inactive" })
    return activeCompany
  }

  async deleteUser(companyId: string) {
    const companyUser = await userModel.findCompanyUsers(companyId)
    if (!companyUser) {
      throw new HTTP401Error({ message: "Company not have any active user" })
    }

    for (const user of companyUser) {
      await userModel.delete(user.id)
    }

    const deleteCompany = await companyModel.delete(companyId)
    return deleteCompany
  }

  async suspendCompany(companyId: string) {
    const companyActiveUser = await userModel.findCompanyUsers(companyId)
    if (!companyActiveUser) {
      throw new HTTP401Error({ message: "Company not have any active user to suspend" })
    }

    for (const user of companyActiveUser) {
      await userModel.update(user.id, { status: "suspend" })
    }

    const suspendCompany = await companyModel.update(companyId, { status: 'suspend' })
    return suspendCompany
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


