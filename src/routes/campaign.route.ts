import { Router } from 'express';
import { uploadMediaMiddleware } from '@surefy/middleware/upload.middleware';
import CampaignController from '@surefy/console/http/controllers/campaign.controller';

const CampaignRoute = Router();

// All campaign endpoints require authentication (applied at route group level)

// Campaign CRUD
CampaignRoute.post('/', CampaignController.createCampaign);
CampaignRoute.get('/', CampaignController.getCampaigns);
CampaignRoute.get('/:id', CampaignController.getCampaignById);
CampaignRoute.delete('/:id', CampaignController.deleteCampaign);

// Campaign actions
CampaignRoute.post('/:id/start', CampaignController.startCampaign);
CampaignRoute.post('/:id/pause', CampaignController.pauseCampaign);
CampaignRoute.post('/:id/resume', CampaignController.resumeCampaign);
CampaignRoute.post('/:id/test', CampaignController.testCampaign);

// Campaign stats
CampaignRoute.get('/:id/stats', CampaignController.getCampaignStats);
CampaignRoute.get("/:id/messages", CampaignController.getCampaignMessagesInfo)
CampaignRoute.get('/:id/progress', CampaignController.getCampaignProgress);

// Media upload
CampaignRoute.post('/upload-media', uploadMediaMiddleware, CampaignController.uploadMedia);

export default CampaignRoute;
