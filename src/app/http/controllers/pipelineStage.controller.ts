import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import PipelineStageModel from '@surefy/console/models/pipelineStage.model';

class PipelineStageController {
  /**
   * GET /v1/admin/pipeline-stages
   * Retrieve all stages for the current user
   */
  getStages = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const stages = await PipelineStageModel.findByUser(req.userId!);
    return successResponse(req, res, 'Pipeline stages retrieved successfully', stages);
  });

  /**
   * POST /v1/admin/pipeline-stages
   * Create new pipeline stage
   */
  createStage = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { name, color, bg_color, border_color, header_bg, position } = req.body;

    if (!name) {
      throw new HTTP400Error({ message: 'Name is required' });
    }

    const stage = await PipelineStageModel.create({
      user_id: req.userId!,
      company_id: req.companyId!,
      name,
      color: color || 'text-blue-600',
      bg_color: bg_color || 'bg-blue-50 dark:bg-blue-950/20',
      border_color: border_color || 'border-blue-200 dark:border-blue-800',
      header_bg: header_bg || 'bg-blue-50 dark:bg-blue-950/40',
      position: position !== undefined ? position : 0,
    });

    return successResponse(req, res, 'Pipeline stage created successfully', stage, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/admin/pipeline-stages/:id
   * Get stage by ID
   */
  getStageById = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const stage = await PipelineStageModel.findOne({ id, user_id: req.userId! });

    if (!stage) {
      throw new HTTP404Error({ message: 'Pipeline stage not found' });
    }

    return successResponse(req, res, 'Pipeline stage retrieved successfully', stage);
  });

  /**
   * PUT /v1/admin/pipeline-stages/:id
   * Update pipeline stage details
   */
  updateStage = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { name, color, bg_color, border_color, header_bg, position } = req.body;

    const stage = await PipelineStageModel.findOne({ id, user_id: req.userId! });
    if (!stage) {
      throw new HTTP404Error({ message: 'Pipeline stage not found' });
    }

    const updated = await PipelineStageModel.update(id, {
      name: name !== undefined ? name : stage.name,
      color: color !== undefined ? color : stage.color,
      bg_color: bg_color !== undefined ? bg_color : stage.bg_color,
      border_color: border_color !== undefined ? border_color : stage.border_color,
      header_bg: header_bg !== undefined ? header_bg : stage.header_bg,
      position: position !== undefined ? position : stage.position,
      updated_at: new Date()
    });

    return successResponse(req, res, 'Pipeline stage updated successfully', updated);
  });

  /**
   * DELETE /v1/admin/pipeline-stages/:id
   * Delete pipeline stage
   */
  deleteStage = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    const stage = await PipelineStageModel.findOne({ id, user_id: req.userId! });
    if (!stage) {
      throw new HTTP404Error({ message: 'Pipeline stage not found' });
    }

    await PipelineStageModel.delete(id);
    return successResponse(req, res, 'Pipeline stage deleted successfully');
  });
}

export default new PipelineStageController();
