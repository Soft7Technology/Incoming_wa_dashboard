import { Router } from 'express';
import { uploadMediaMiddleware } from '@surefy/middleware/upload.middleware';
import CampaignController from '@surefy/console/http/controllers/campaign.controller';
import { checkPlanLimit } from "@surefy/console/app/middleware/plan.middleware"

const CampaignRoute = Router();

// All campaign endpoints require authentication (applied at route group level)

// Campaign CRUD
// CampaignRoute.post('/', checkPlanLimit('Campaign'), CampaignController.createCampaign);
CampaignRoute.post('/', CampaignController.createCampaign);
CampaignRoute.get('/', CampaignController.getCampaigns);

// User-specific campaigns — MUST come before /:id to avoid route collision
CampaignRoute.get('/user/:userId', CampaignController.getUsersCampaigns);

// Media upload — also before /:id to avoid collision with /upload-media
CampaignRoute.post('/upload-media', uploadMediaMiddleware, CampaignController.uploadMedia);

// Parameterized routes
CampaignRoute.get('/:id', CampaignController.getCampaignById);
CampaignRoute.delete('/:id', CampaignController.deleteCampaign);

// Campaign actions
CampaignRoute.post('/:id/start', CampaignController.startCampaign);
CampaignRoute.post('/:id/pause', CampaignController.pauseCampaign);
CampaignRoute.post('/:id/resume', CampaignController.resumeCampaign);
CampaignRoute.post('/:id/test', CampaignController.testCampaign);

// Campaign stats
CampaignRoute.get('/:id/stats', CampaignController.getCampaignStats);
CampaignRoute.get('/:id/messages', CampaignController.getCampaignMessagesInfo);
CampaignRoute.get('/:id/buttonOnClicks', CampaignController.getCampaignButtonClicks);
CampaignRoute.get('/:id/progress', CampaignController.getCampaignProgress);


export default CampaignRoute;