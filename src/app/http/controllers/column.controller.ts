import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
 import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import ColumnModel from '../../models/column.model';

class ColumnController {


  
  /**
   * GET /v1/admin/columns
   * Get all columns for the current user/company
   */
  getColumns = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    // Use ownerId so team members share the account owner's column config
    const effectiveUserId = req.ownerId ?? req.userId!;
    const columns = await ColumnModel.findByUser(effectiveUserId);
    return successResponse(req, res, 'Columns retrieved successfully', columns);
  });

  /**
   * POST /v1/admin/columns
   * Create new column
   */
  createColumn = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { label, type, visible } = req.body;

    if (!label || !type) {
      throw new HTTP400Error({ message: 'Label and type are required' });
    }

    const column = await ColumnModel.create({
      user_id: req.userId!,
      company_id: req.companyId!,
      label,
      type: type.toUpperCase(), // Ensure unified type format e.g. TEXT, NUMBER, DATE, BOOLEAN
      visible: visible !== undefined ? visible : true,
    });

    return successResponse(req, res, 'Column created successfully', column, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/admin/columns/:id
   * Get column by ID
   */
  getColumnById = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const column = await ColumnModel.findOne({ id, user_id: req.userId! });

    if (!column) {
      throw new HTTP404Error({ message: 'Column not found' });
    }

    return successResponse(req, res, 'Column retrieved successfully', column);
  });

  /**
   * PUT /v1/admin/columns/:id
   * Update column details
   */
  updateColumn = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { label, type, visible } = req.body;

    const column = await ColumnModel.findOne({ id, user_id: req.userId! });
    if (!column) {
      throw new HTTP404Error({ message: 'Column not found' });
    }

    const updated = await ColumnModel.update(id, {
      label: label !== undefined ? label : column.label,
      type: type !== undefined ? type.toUpperCase() : column.type,
      visible: visible !== undefined ? visible : column.visible,
      updated_at: new Date()
    });

    return successResponse(req, res, 'Column updated successfully', updated);
  });

  /**
   * PATCH /v1/admin/columns/:id
   * Toggle visibility / update specific fields
   */
  patchColumn = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { visible } = req.body;

    const column = await ColumnModel.findOne({ id, user_id: req.userId! });
    if (!column) {
      throw new HTTP404Error({ message: 'Column not found' });
    }

    const updated = await ColumnModel.update(id, {
      visible: visible !== undefined ? visible : column.visible,
      updated_at: new Date()
    });

    return successResponse(req, res, 'Column visibility updated successfully', updated);
  });

  /**
   * DELETE /v1/admin/columns/:id
   * Delete column
   */
  deleteColumn = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    const column = await ColumnModel.findOne({ id, user_id: req.userId! });
    if (!column) {
      throw new HTTP404Error({ message: 'Column not found' });
    }

    await ColumnModel.delete(id);
    return successResponse(req, res, 'Column deleted successfully');
  });
}

export default new ColumnController();
