import CompanyRepository from '@surefy/console/repository/company.repository';
import { CreateCompanyDto, UpdateCompanyDto } from '@surefy/console/interfaces/company.interface';
import { generateCompanyKey } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import AuthService from './auth.service';

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
        email: userData.email,
        phone: userData.phone,
        password: userData.password,
        company_id: company.id,
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
   * Get company details
   */
  async getCompanyById(id: string) {
    const company = await CompanyRepository.findById(id);
    if (!company) {
      throw new HTTP404Error({ message: 'Company not found' });
    }
    return company;
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
}

export default new CompanyService();
