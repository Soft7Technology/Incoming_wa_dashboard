import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import CampaignService from '@surefy/console/services/campaign.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class CampaignController {
  /**
   * POST /v1/campaigns
   * Create new campaign
   */
  createCampaign = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const {
      name,
      description,
      phone_number_id,
      template_id,
      contact_filters,
      parameter_mapping,
      media_uploads,
      scheduled_at,
    } = req.body;

    console.log('Creating campaign with data:', req.body);

    if (!name || !phone_number_id || !template_id) {
      throw new HTTP400Error({ message: 'Name, phone_number_id, and template_id are required' });
    }

    const campaign = await CampaignService.createCampaign(req.userId!, {
      name,
      description,
      phone_number_id,
      template_id,
      contact_filters,
      parameter_mapping,
      media_uploads,
      scheduled_at,
    });

    return successResponse(req, res, 'Campaign created successfully', campaign, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/campaigns
   * Get all campaigns
   */
  getCampaigns = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const filters = {
      status: req.query.status,
      phone_number_id: req.query.phone_number_id,
      search: req.query.search,
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await CampaignService.getCampaigns( req.userId!, filters);
    return successResponse(req, res, 'Campaigns retrieved successfully', result);
  });

  /**
   * GET /v1/campaigns/:id
   * Get campaign by ID
   */
  getCampaignById = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const campaign = await CampaignService.getCampaignById(id);
    return successResponse(req, res, 'Campaign retrieved successfully', campaign);
  });

  /**
   * POST /v1/campaigns/:id/start
   * Start campaign execution
   */
  startCampaign = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const result = await CampaignService.startCampaign(id);
    return successResponse(req, res, result.message);
  });

  /**
   * POST /v1/campaigns/:id/pause
   * Pause running campaign
   */
  pauseCampaign = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const result = await CampaignService.pauseCampaign(id);
    return successResponse(req, res, result.message);
  });

  /**
   * POST /v1/campaigns/:id/resume
   * Resume paused campaign
   */
  resumeCampaign = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const result = await CampaignService.resumeCampaign(id);
    return successResponse(req, res, result.message);
  });

  /**
   * POST /v1/campaigns/:id/test
   * Test campaign with a single number
   */
  testCampaign = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { test_phone_number } = req.body;

    if (!test_phone_number) {
      throw new HTTP400Error({ message: 'test_phone_number is required' });
    }

    const result = await CampaignService.testCampaign(id, test_phone_number);
    return successResponse(req, res, 'Test message sent successfully', result);
  });

  /**
   * GET /v1/campaigns/:id/stats
   * Get campaign statistics
   */
  getCampaignStats = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const stats = await CampaignService.getCampaignStats(id);
    return successResponse(req, res, 'Campaign statistics retrieved successfully', stats);
  });

  /**
   * GET /v1/campaigns/:id/progress
   * Get campaign execution progress
   */
  getCampaignProgress = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const progress = await CampaignService.getCampaignProgress(id);
    return successResponse(req, res, 'Campaign progress retrieved successfully', progress);
  });

  /**
   * GET /v1/campaigns/:id/messages
   * Get campaign messages info
   */
  getCampaignMessagesInfo = tryCatchAsync(async (req:Request, res:Response) => {
     const {status} = req.query; 
     const {id} = req.params;
     const page = Number(req.query.page) || 1;
     const pageSize = Number(req.query.pageSize) || 10;
     const messagesInfo = await CampaignService.getCampaignMessagesInfo(
        id,
        status as string | undefined,
        page,
        pageSize
    );
     return successResponse(req,res,'Campaign messages info retrieved successfully',messagesInfo);
  })

  /**
   * DELETE /v1/campaigns/:id
   * Delete campaign
   */
  deleteCampaign = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await CampaignService.deleteCampaign(id);
    return successResponse(req, res, 'Campaign deleted successfully');
  });

  /**
   * POST /v1/campaigns/upload-media
   * Upload media for campaign template
   */
  uploadMedia = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { phone_number_id, type } = req.body;
    console.log('Uploaded file:', req.file);
    console.log('Request body:', req.body);
    const file = req.file;

    if (!phone_number_id || !type || !file) {
      throw new HTTP400Error({ message: 'phone_number_id, type, and file are required' });
    }

    const result = await CampaignService.uploadMedia(req.companyId!, phone_number_id, file, type);
    return successResponse(req, res, 'Media uploaded successfully', result, HttpStatusCode.CREATED);
  });
}

export default new CampaignController();
