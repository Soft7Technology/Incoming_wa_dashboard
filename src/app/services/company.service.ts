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
import { transformFeatures } from '../utils'


class CompanyService {
  /**
   * Onboard new company with initial user
   */
  async onboardCompany(data: CreateCompanyDto) {
    // Check if email already exists
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
      });
    }

    // Return company with key and user (only returned once during onboarding)
    return {
      company: {
        ...company,
      },
      user: createdUser,
      apiKey: company.api_key,
      companyKey: companyKey,
    };
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
  async updateCompany(id: string, data: UpdateCompanyDto) {
    const company = await this.getCompanyById(id);

    // If email is being updated, check uniqueness
    if (data.email && data.email !== company.email) {
      const existingCompany = await CompanyRepository.findByEmail(data.email);
      if (existingCompany) {
        throw new HTTP400Error({ message: 'Company with this email already exists' });
      }
    }

    return CompanyRepository.update(id, data);
  }

  /**
   * Delete company
   */
  async deleteCompany(id: string) {
    await this.getCompanyById(id);
    return CompanyRepository.delete(id);
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

  async getDashboardStats(companyId: string,userId:string) {
    console.log('Fetching dashboard stats for companyId:', companyId); // Debug log
    const stats = await companyModel.getDashboardStats(companyId,userId);
    return stats;
  }

  async getAllUsers(companyId: string,role?:any) {
    const users = await userModel.findAllUserByCompanyId(companyId,role);
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

  async updateCompanyUser(userId: string, data: any) {
    // Check if user belongs to the company
    const user = await userModel.findById(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }
    const updatedUser = await userModel.updateUser(userId, data);
    return updatedUser;
  }

  async createUserPlan(userId: string, planData: any,razorPayDetails:any) {
    const { plan_name, price, billing_cycle, features } = planData;

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
      plan_name,
      price,
      billing_cycle,
      razorpayOrderId:razorPayDetails.id,
      // razorpaymentId,
      // razorpaySignature,
      start_date: startDate,
      end_date: endDate,
      limits: JSON.stringify(limits), // JSONB
      usage: JSON.stringify(usage), // JSONB
      active: true,
    });
    return newUserPlan;
  }

  /**
   * Create user under company
   */
  async createUser(
    companyId: string,
    userData: { name: string; email?: string; phone?: string; password: string; role: string; permissions?: string[] },
  ) {
    const existingUser = await userModel.findByEmail(userData.email);

    if (existingUser) {
      throw new HTTP400Error({ message: 'User with this email already exists' });
    }

    if (!companyId) {
      throw new HTTP400Error({ message: 'Company ID is required to create user' });
    }

    let createdUser = null;
    if (userData) {
      createdUser = await AuthService.register({
        name: userData.name,
        company_id: companyId,
        email: userData.email,
        phone: userData.phone,
        password: userData.password,
        role: userData.role,
        permissions: userData.permissions,
      });
    }
    return createdUser;
  }

  async deleteUserById(userId:string){
    const deleteUser = await userModel.delete(userId)
    return deleteUser

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
