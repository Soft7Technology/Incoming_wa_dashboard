import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import ContactService from '@surefy/console/services/contact.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import * as path from 'path';
import * as fs from 'fs';

class ContactController {
  /**
   * POST /v1/contacts
   * Create new contact
   */
  createContact = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { phone_number, name, email, attributes, notes, tag_ids } = req.body;

    if (!phone_number) {
      throw new HTTP400Error({ message: 'Phone number is required' });
    }

    const contact = await ContactService.createContact(req.userId!, {
      phone_number,
      name,
      email,
      attributes,
      notes,
      tag_ids,
    });

    return successResponse(req, res, 'Contact created successfully', contact, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/contacts
   * Get all contacts with filters
   */
  getContacts = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const filters = {
      is_valid: req.query.is_valid,
      search: req.query.search,
      tag_ids: req.query.tag_ids ? String(req.query.tag_ids).split(',') : undefined,
      list_ids: req.query.list_ids ? String(req.query.list_ids).split(',') : undefined,
      page: req.query.page,
      limit: req.query.limit,
    };

    const contacts = await ContactService.getContacts(req.userId!, filters);
    return successResponse(req, res, 'Contacts retrieved successfully', contacts);
  });

  /**
   * GET /v1/contacts/:id
   * Get contact by ID
   */
  getContactById = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const contact = await ContactService.getContactById(id);
    return successResponse(req, res, 'Contact retrieved successfully', contact);
  });

  /**
   * PUT /v1/contacts/:id
   * Update contact
   */
  updateContact = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, email, attributes, notes, tag_ids } = req.body;

    const contact = await ContactService.updateContact(id, {
      name,
      email,
      attributes,
      notes,
      tag_ids,
    });

    return successResponse(req, res, 'Contact updated successfully', contact);
  });

  /**
   * DELETE /v1/contacts/:id
   * Delete contact
   */
  deleteContact = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await ContactService.deleteContact(id);
    return successResponse(req, res, 'Contact deleted successfully');
  });

  /**
   * POST /v1/contacts/import/preview
   * Preview XLSX file before import
   */
  previewImport = tryCatchAsync(async (req: Request, res: Response) => {
    const file = req.file;

    if (!file) {
      throw new HTTP400Error({ message: 'XLSX file is required' });
    }

    const preview = await ContactService.getXLSXPreview(file.path);
    console.log(`Generated preview: ${JSON.stringify(preview)}`);

    // Clean up temporary file
    fs.unlinkSync(file.path);

    return successResponse(req, res, 'File preview generated successfully', preview);
  });

  /**
   * POST /v1/contacts/import
   * Queue contact import from XLSX (async processing)
   */
  importContacts = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const file = req.file;
    const { list_name, phone_column, name_column, email_column, tag_ids } = req.body;

    console.log("Request file",req.body)

    if (!file) {
      throw new HTTP400Error({ message: 'XLSX file is required' });
    }

    if (!list_name) {
      throw new HTTP400Error({ message: 'List name is required' });
    }

    // Define upload directory
    const uploadDir = path.join(process.cwd(), 'uploads', 'contacts', req.userId!);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Move file to permanent location
    const fileName = `${Date.now()}_${file.originalname}`;
    const filePath = path.join(uploadDir, fileName);
    fs.renameSync(file.path, filePath);

    // Queue the import job instead of processing synchronously
    const importJob = await ContactService.queueContactImport(req.userId!, filePath, list_name, {
      phoneColumn: phone_column,
      nameColumn: name_column,
      emailColumn: email_column,
      tagIds: tag_ids ? tag_ids.split(',') : undefined,
    });

    return successResponse(
      req,
      res,
      'Contact import job queued successfully. Use the job_id to check progress.',
      {
        job_id: importJob.id,
        status: importJob.status,
        total_rows: importJob.total_rows,
        progress_percentage: importJob.progress_percentage,
      },
      HttpStatusCode.ACCEPTED
    );
  });

  /**
   * GET /v1/contacts/import/:jobId/status
   * Get import job status and progress
   */
  getImportStatus = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;

    const status = await ContactService.getImportJobStatus(jobId);

    return successResponse(req, res, 'Import job status retrieved successfully', status);
  });

  /**
   * GET /v1/contacts/import/jobs
   * Get all import jobs for company
   */
  getImportJobs = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const filters = {
      status: req.query.status,
      job_type: req.query.job_type,
    };

    const jobs = await ContactService.getImportJobs(req.companyId!, filters);
    return successResponse(req, res, 'Import jobs retrieved successfully', jobs);
  });

  /**
   * POST /v1/contacts/:id/tags
   * Add tags to contact
   */
  addTags = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { tag_ids } = req.body;

    if (!tag_ids || !Array.isArray(tag_ids)) {
      throw new HTTP400Error({ message: 'tag_ids array is required' });
    }

    await ContactService.addTagsToContact(id, tag_ids);
    return successResponse(req, res, 'Tags added successfully');
  });

  /**
   * DELETE /v1/contacts/:id/tags
   * Remove tags from contact
   */
  removeTags = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { tag_ids } = req.body;

    if (!tag_ids || !Array.isArray(tag_ids)) {
      throw new HTTP400Error({ message: 'tag_ids array is required' });
    }

    await ContactService.removeTagsFromContact(id, tag_ids);
    return successResponse(req, res, 'Tags removed successfully');
  });

  /**
   * POST /v1/contacts/tags
   * Create new tag
   */
  createTag = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { name, color, description } = req.body;

    if (!name) {
      throw new HTTP400Error({ message: 'Tag name is required' });
    }

    const tag = await ContactService.createTag(req.userId!, { name, color, description });
    return successResponse(req, res, 'Tag created successfully', tag, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/contacts/tags
   * Get all tags
   */
  getTags = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const tags = await ContactService.getTags(req.userId!);
    return successResponse(req, res, 'Tags retrieved successfully', tags);
  });

  /**
   * PUT /v1/contacts/tags/:id
   * Update tag
   */
  updateTag = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, color, description } = req.body;

    const tag = await ContactService.updateTag(id, { name, color, description });
    return successResponse(req, res, 'Tag updated successfully', tag);
  });

  /**
   * DELETE /v1/contacts/tags/:id
   * Delete tag
   */
  deleteTag = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await ContactService.deleteTag(id);
    return successResponse(req, res, 'Tag deleted successfully');
  });

  /**
   * GET /v1/contacts/lists
   * Get all contact lists
   */
  getLists = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const lists = await ContactService.getLists(req.userId!);
    return successResponse(req, res, 'Lists retrieved successfully', lists);
  });

  /**
   * GET /v1/contacts/lists/:id
   * Get list by ID
   */
  getListById = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const list = await ContactService.getListById(id);
    return successResponse(req, res, 'List retrieved successfully', list);
  });

  /**
   * GET /v1/contacts/lists/:id/contacts
   * Get contacts in a list
   */
  getListContacts = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const filters = {
      is_valid: req.query.is_valid,
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await ContactService.getListContacts(id, filters);
    return successResponse(req, res, 'List contacts retrieved successfully', result);
  });

  /**
   * DELETE /v1/contacts/lists/:id
   * Delete list
   */
  deleteList = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await ContactService.deleteList(id);
    return successResponse(req, res, 'List deleted successfully');
  });

  /**
   * GET /v1/contacts/import/sample
   * Download sample import template
   */
  downloadSampleTemplate = tryCatchAsync(async (req: Request, res: Response) => {
    const buffer = await ContactService.generateSampleTemplate();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts_import_sample.xlsx');
    res.send(buffer);
  });
}

export default new ContactController();