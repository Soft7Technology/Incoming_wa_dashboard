import * as cron from 'node-cron';
import CampaignModel from '../models/campaign.model';
import CampaignService from './campaign.service';

class CampaignSchedulerService {
  private isRunning: boolean = false;

  /**
   * Start the campaign scheduler
   * Checks for scheduled campaigns every minute
   */
  start() {
    if (this.isRunning) {
      console.log('Campaign scheduler is already running');
      return;
    }

    console.log('Starting campaign scheduler...');
    this.isRunning = true;

    // Run every minute
    cron.schedule('* * * * *', async () => {
      await this.checkScheduledCampaigns();
    });

    console.log('Campaign scheduler started successfully');
  }

  /**
   * Check for campaigns that are scheduled to run now
   */
  private async checkScheduledCampaigns() {
    try {
      const now = new Date();
      console.log(`[Campaign Scheduler] Checking for scheduled campaigns at ${now.toISOString()}`);

      const campaigns = await CampaignModel.getScheduledCampaigns();

      console.log(`[Campaign Scheduler] Found ${campaigns.length} scheduled campaign(s) ready to execute`);

      if (campaigns.length === 0) {
        return;
      }

      // Start each campaign
      for (const campaign of campaigns) {
        try {
          console.log(`[Campaign Scheduler] Starting campaign: ${campaign.id} - ${campaign.name} (scheduled at: ${campaign.scheduled_at})`);
          const result = await CampaignService.startCampaign(campaign.id);
          console.log(`[Campaign Scheduler] Campaign ${campaign.id} queued successfully:`, result);
        } catch (error: any) {
          console.error(`[Campaign Scheduler] Failed to start campaign ${campaign.id}:`, error.message);
          // Mark campaign as failed
          await CampaignModel.updateStatus(campaign.id, 'failed');
        }
      }
    } catch (error: any) {
      console.error('[Campaign Scheduler] Error checking scheduled campaigns:', error.message);
    }
  }

  /**
   * Stop the scheduler (for graceful shutdown)
   */
  stop() {
    this.isRunning = false;
    console.log('Campaign scheduler stopped');
  }
}

export default new CampaignSchedulerService();
