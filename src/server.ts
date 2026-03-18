import createBaseApp from '@surefy/server';
import ApiRoute from '@surefy/console/routes/api.route';
import CampaignSchedulerService from '@surefy/console/services/campaignScheduler.service';

// Only start server if not in worker mode
if (process.env.WORKER_MODE !== 'true') {
  // Start the campaign scheduler
  CampaignSchedulerService.start();

  createBaseApp([{ basePath: '/v1', route: ApiRoute }]);
} else {
  console.log('Worker mode detected - skipping server startup');
}
