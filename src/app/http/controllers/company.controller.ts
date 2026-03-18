import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import CompanyService from '@surefy/console/services/company.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';

class CompanyController {
  /**
   * POST /v1/companies
   * Onboard new company
   */
  onboard = tryCatchAsync(async (req: Request, res: Response) => {
    const { name, email, phone, business_id, webhook_url, meta_config, settings, initial_credit, user } = req.body;

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
      business_id,
      webhook_url,
      meta_config,
      settings,
      initial_credit,
      user,
    });

    return successResponse(req, res, 'Company and user created successfully', result, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/companies/:id
   * Get company details
   */
  getById = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const company = await CompanyService.getCompanyById(id);
    return successResponse(req, res, 'Company retrieved successfully', company);
  });

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
}

export default new CompanyController();
