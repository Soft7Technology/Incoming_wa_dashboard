import 'dotenv/config';
import createBaseApp from '@surefy/server';
import ApiRoute from '@surefy/console/routes/api.route';
import CampaignSchedulerService from '@surefy/console/services/campaignScheduler.service';
import ShopifyPrivacyScheduler from './app/services/shopifyPrivacyScheduler.service';

// Only start server if not in worker mode
if (process.env.WORKER_MODE !== 'true') {
  createBaseApp([{ basePath: '/v1', route: ApiRoute }], {
    onListening: () => {
      CampaignSchedulerService.start();
      ShopifyPrivacyScheduler.start();
    },
    onShutdown: () => {
      CampaignSchedulerService.stop();
      ShopifyPrivacyScheduler.stop();
    },
  });
} else {
  console.log('Worker mode detected - skipping server startup');
}
