import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import TemplateService from '@surefy/console/services/template.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class TemplateController {
  /**
   * POST /v1/templates/sync
   * Sync templates from Meta
   */
  syncTemplates = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { waba_id } = req.body;

    if (!waba_id) {
      throw new HTTP400Error({ message: 'WABA ID is required' });
    }

    const effectiveUserId = req.ownerId ?? req.userId!;
    const templates = await TemplateService.syncTemplates(effectiveUserId, waba_id, req.companyId!);
    return successResponse(req, res, `${templates.length} templates synced successfully`, templates);
  });
  

  /**
   * POST /v1/templates
   * Create new template
   */
  createTemplate = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { waba_id, name, language, category, components, parameter_format, message_send_ttl_seconds } = req.body;

    if (!waba_id || !name || !language || !category || !components) {
      throw new HTTP400Error({
        message: 'WABA ID, name, language, category, and components are required',
      });
    }

    const template = await TemplateService.createTemplate({
      company_id: req.companyId!,
      user_id: (req.ownerId ?? req.userId)!,
      parameter_format,
      message_send_ttl_seconds,
      waba_id,
      name,
      language,
      category,
      components,
    });

    return successResponse(req, res, 'Template created successfully', template, HttpStatusCode.CREATED);
  });

  updateTemplate = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const template = await TemplateService.updateTemplate(req.params.id, req.body, {
      companyId: req.companyId!, userId: (req.ownerId ?? req.userId)!,
    });
    return successResponse(req, res, 'Template updated successfully', template);
  });

  /**
   * GET /v1/templates
   * Get all templates for company
   */
  getTemplates = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { status, category, language, wabaId,phoneNumberId } = req.query;
    const effectiveUserId = req.ownerId ?? req.userId!;
    for (const value of [wabaId, phoneNumberId, status, category, language]) {
      if (value !== undefined && typeof value !== 'string') throw new HTTP400Error({ message: 'Template filters must be strings' });
    }
    const waba_id = wabaId as string | undefined;
    const phone_number_id = phoneNumberId as string | undefined;

    const templates = await TemplateService.getTemplates(effectiveUserId, req.companyId!, waba_id, phone_number_id,{
      status,
      category,
      language,
    });

    return successResponse(req, res, 'Templates retrieved successfully', templates);
  });

  /**
   * GET /v1/templates/:id
   * Get template by ID
   */
  getTemplateById = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const template = await TemplateService.getTemplateById(id, { companyId: req.companyId!, userId: (req.ownerId ?? req.userId)! });
    return successResponse(req, res, 'Template retrieved successfully', template);
  });

  /**
   * DELETE /v1/templates/:id
   * Delete template
   */
  deleteTemplate = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    await TemplateService.deleteTemplate(id, { companyId: req.companyId!, userId: (req.ownerId ?? req.userId)! });
    return successResponse(req, res, 'Template deleted successfully');
  });
}

export default new TemplateController();
