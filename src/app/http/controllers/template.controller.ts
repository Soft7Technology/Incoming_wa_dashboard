import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import TemplateService from '@surefy/console/services/template.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class TemplateController {
  /**
   * POST /v1/templates/sync
   * Sync templates from Meta
   */
  syncTemplates = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { waba_id } = req.body;

    if (!waba_id) {
      throw new HTTP400Error({ message: 'WABA ID is required' });
    }

    const templates = await TemplateService.syncTemplates(req.userId!, waba_id);
    return successResponse(req, res, `${templates.length} templates synced successfully`, templates);
  });

  /**
   * POST /v1/templates
   * Create new template
   */
  createTemplate = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { waba_id, name, language, category, components } = req.body;

    if (!waba_id || !name || !language || !category || !components) {
      throw new HTTP400Error({
        message: 'WABA ID, name, language, category, and components are required',
      });
    }

    const template = await TemplateService.createTemplate({
      company_id: req.companyId!,
      waba_id,
      name,
      language,
      category,
      components,
    });

    return successResponse(req, res, 'Template created successfully', template, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/templates
   * Get all templates for company
   */
  getTemplates = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { status, category } = req.query;

    const templates = await TemplateService.getTemplates(req.userId!, {
      status,
      category,
    });

    return successResponse(req, res, 'Templates retrieved successfully', templates);
  });

  /**
   * GET /v1/templates/:id
   * Get template by ID
   */
  getTemplateById = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const template = await TemplateService.getTemplateById(id);
    return successResponse(req, res, 'Template retrieved successfully', template);
  });

  /**
   * DELETE /v1/templates/:id
   * Delete template
   */
  deleteTemplate = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await TemplateService.deleteTemplate(id);
    return successResponse(req, res, 'Template deleted successfully');
  });
}

export default new TemplateController();
