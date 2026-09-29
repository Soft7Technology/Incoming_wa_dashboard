import { calculatePlanPeriod } from '../utils/subscriptionDuration';
import planAssignmentService from './planAssignment.service';
import db from '@surefy/database';
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
import companyDomainModel from '../models/companyDomain.model';
import axios from 'axios'

class CompanyService {
  /**
   * Onboard new company with initial user
   */
  async onboardCompany(data: CreateCompanyDto) {
    if (!data.user) {
      throw new HTTP400Error({ message: 'Initial user is required' });
    }
    return db.transaction(async (trx) => {
      // Check if email already exists

      const existingCompany = await trx('companies').where({ email: data.email }).first();
      if (existingCompany) {
        throw new HTTP400Error({ message: 'Company with this email already exists' });
      }

      // Extract user data before creating company
      const userData = data.user;
      const { user, ...companyData } = data;

      // Create company (without user field)
      const company = await CompanyRepository.create(companyData, trx);

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
        }, trx);
      }

      const freePlan = await subscriptionModel.createFreePlan(createdUser.id, company.id, trx);

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
    });
  }

  private async createCustomerName(company_domain: any) {
    try {
      const payload = {
        hostname: company_domain.domain_name,

        // custom_origin_server: "app.soft7.in",

        // custom_origin_sni: "app.soft7.in",

        ssl: {
          method: "txt",
          type: "dv",
        },
      };

      console.log("PAYLOAD:", payload, process.env.CLOUDFLARE_API_TOKEN);

      const response = await axios.post(
        "https://api.cloudflare.com/client/v4/zones/1b1e4a9725e08e652c177d3cfc2e3eed/custom_hostnames",
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("Cloudflare Response:", response.data);

      return response.data;
    } catch (error: any) {
      console.error("Cloudflare Custom Hostname Error");

      if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Response:", error.response.data);

        throw new Error(
          error.response.data?.errors?.[0]?.message ||
          "Cloudflare API request failed"
        );
      }

      if (error.request) {
        console.error("No response received:", error.request);

        throw new Error(
          "No response received from Cloudflare. Check network connectivity."
        );
      }

      console.error("Unexpected Error:", error.message);

      throw new Error(error.message || "Unknown error occurred");
    }
  }

  private async getCustomHostnameDetails(hostnameId: string) {
    console.log("Token",process.env.CLOUDFLARE_API_TOKEN,hostnameId)
    const response = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/1b1e4a9725e08e652c177d3cfc2e3eed/custom_hostnames/${hostnameId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.result;
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
  async getAllCompanies(companyId: string, filters: any) {
    return CompanyRepository.getAllCompanies(companyId, filters);
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

  async getAllUsers(userId: string, companyId: string, role: string, filters?: any) {
    const user = await userModel.findById(userId);

    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }
    const users = await userModel.findAllUserByCompanyId(companyId, role, filters);
    return users;
  }

  async getUserById(userId: string) {
    const user = await userModel.findWithAssignedPlan(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    } else {
      return user;
    }
  }

  async updateCompanyUser(userId: string, data: any, actor?: { userId?: string; companyId?: string; userRole?: string }) {
    const result = await planAssignmentService.updateUser(userId, data, actor);
    return result.user;
  }

  async createUserPlan(userId: string, companyId: string, planData: any, razorPayDetails: any) {
    const { plan_name, price, billing_cycle, features } = planData;

    const { limits, usage } = transformFeatures(features);
    console.log('Transformed limits:', limits);
    console.log('Transformed usage:', usage);

    const startDate = new Date();
    const { endDate, durationDays } = calculatePlanPeriod(planData, startDate);

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

  async createCustomName(user_id: string, company_id: string, hostname: string) {
    const createCustomerName = await companyDomainModel.create({
      user_id: user_id,
      company_id: company_id,
      hostname: hostname,
      domain_name: hostname,
      status: "pending",
      ssl_status: "pending",
      domain_type: 'custom'
    })
    return createCustomerName
  }

  async createDomainName(
    user_id: string,
    company_id: string,
    domain_name: string
  ) {
    const companyDomain = await companyDomainModel.create({
      user_id,
      company_id,
      hostname: domain_name,
      domain_name,
      status: "pending",
      ssl_status: "pending",
      domain_type: "own",
    });

    const response = await this.approvedCompanyOwnDomain(
      companyDomain.id
    );

    if (!response.success) {
      throw new Error(
        response.message || "Cloudflare hostname creation failed"
      );
    }

    const details = response.data;

    const ownershipVerification = {
      type:
        details.ownership_verification?.type || "txt",

      name:
        details.ownership_verification?.name || null,

      value:
        details.ownership_verification?.value || null,
    };

    const sslValidationRecords =
      details.ssl?.validation_records?.map(
        (record: any) => ({
          type: "txt",
          name: record.txt_name,
          value: record.txt_value,
        })
      ) || [];

    await companyDomainModel.update(companyDomain.id, {
      cloudfare_hostname_id: details.id,

      hostname: details.hostname,

      domain_name: details.hostname,

      status: details.status,

      ssl_status: details.ssl?.status,

      ownership_verification: ownershipVerification,

      ssl_validation_records: sslValidationRecords,

      cloudflare_metadata: details,
    });

    return await companyDomainModel.getCompanyDomainById(
      companyDomain.id
    );
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

  async getCompanyDomains(userId: string) {
    const companyDomain = await companyDomainModel.getCompanyDomains(userId)
    return companyDomain
  }

  async getCompanyDomainById(custom_domain: string) {
    const companyDomainDetails = await companyDomainModel.getCompanyDomainById(custom_domain)
    return companyDomainDetails
  }

  async approvedCompanyDomain(custom_domain: string) {
    try {
      const companyDomain =
        await companyDomainModel.getCompanyDomainById(custom_domain);

      if (!companyDomain) {
        throw new Error("Company domain not found");
      }

      const response = await this.createCustomerName(companyDomain);

      if (response.duplicate) {
        return {
          success: false,
          message: "Domain already exists in Cloudflare"
        };
      }

      await companyDomainModel.update(custom_domain, {
        cloudfare_hostname_id: response.result.id,
        status: "active",
        ssl_status: "active",
      });

      return {
        success: true
      };
    } catch (error: any) {
      console.error(error);

      return {
        success: false,
        message: error.message
      };
    }
  }

  async approvedCompanyOwnDomain(custom_domain: string) {
    try {
      const companyDomain =
        await companyDomainModel.getCompanyDomainById(custom_domain);

      if (!companyDomain) {
        throw new Error("Company domain not found");
      }

      const createResponse =
        await this.createCustomerName(companyDomain);

      if (createResponse.duplicate) {
        return {
          success: false,
          message: "Domain already exists in Cloudflare",
        };
      }

      const hostnameId = createResponse.result.id;

      const details =
        await this.getCustomHostnameDetails(hostnameId);

      const ownershipVerification = {
        type:
          details.ownership_verification?.type || null,

        name:
          details.ownership_verification?.name || null,

        value:
          details.ownership_verification?.value || null,
      };

      const sslValidationRecords =
        details.ssl?.validation_records?.map(
          (record: any) => ({
            type: "txt",
            name: record.txt_name,
            value: record.txt_value,
          })
        ) || [];

      await companyDomainModel.update(companyDomain.id, {
        cloudfare_hostname_id: details.id,

        domain_name: details.hostname,

        status: details.status,

        ssl_status: details.ssl?.status,

        ssl_method: details.ssl?.method,

        ssl_type: details.ssl?.type,

        ssl_certificate_authority:
          details.ssl?.certificate_authority,

        ownership_verification:
          ownershipVerification,

        ssl_validation_records:
          sslValidationRecords,

        verification_http_url:
          details.ownership_verification_http
            ?.http_url,

        verification_http_body:
          details.ownership_verification_http
            ?.http_body,

        cloudflare_metadata: details,
      });

      return {
        success: true,
        data: details,
      };
    } catch (error: any) {
      console.error(error);

      return {
        success: false,
        message: error.message,
      };
    }
  }

  async inactiveCompanyDomain(custom_domain: string) {
    try {
      const companyDomain =
        await companyDomainModel.getCompanyDomainById(custom_domain);

      if (!companyDomain) {
        throw new Error("Company domain not found");
      }

      const response = await this.createCustomerName(companyDomain);

      const inactiveCompanyDomain = await companyDomainModel.update(
        custom_domain,
        {
          cloudfare_hostname_id: response.result.id,
          status: response.result.status,
          ssl_status: response.result.ssl?.status || null,
        }
      );

      return inactiveCompanyDomain;
    } catch (error: any) {
      console.error(
        "Error inactive company domain:",
        error?.response?.data || error.message
      );

      throw new Error(
        error?.response?.data?.errors?.[0]?.message ||
        "Failed to inactive company domain"
      );
    }
  }

  async getCompanyCustomDomain(companyId: string) {
    const customDomain = await companyDomainModel.findCompanyDomainByCompanyId(companyId)
    return customDomain
  }

  async getDomainStatus(domainId: string) {
    const existDomain = await companyDomainModel.domainById(domainId);

    if (!existDomain) {
      throw new HTTP401Error({
        message: "Domain not exist",
      });
    }

    const response = await this.getCustomHostnameDetails(
      existDomain.cloudfare_hostname_id
    );

    const sslValidationRecords =
      response.ssl?.validation_records?.map((record: any) => ({
        status: record.status,
        type: "txt",
        name: record.txt_name,
        value: record.txt_value,
      })) || [];

    const updateDomainDetails =
      await companyDomainModel.update(existDomain.id, {
        status: response.status,

        ssl_status: response.ssl?.status,

        ssl_validation_records: sslValidationRecords,

        ownership_verification: {
          type: response.ownership_verification?.type,
          name: response.ownership_verification?.name,
          value: response.ownership_verification?.value,
        },
      });

    return updateDomainDetails;
  }
}

export default new CompanyService();


