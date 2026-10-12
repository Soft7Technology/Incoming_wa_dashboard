import { reconcileFailedCampaignJobs } from './campaignRecovery';
import * as cron from 'node-cron';
import CampaignModel from '../models/campaign.model';
import CampaignService from './campaign.service';
import db from '@surefy/database';
import { BackgroundDatabaseGate, backgroundSchemas, checkDatabaseSchema } from '../utils/backgroundDatabase';
import { getDatabaseFailure, reportBackgroundError } from '@surefy/utils/databaseErrors';

class CampaignSchedulerService {
  private isRunning: boolean = false;
  private task?: cron.ScheduledTask;
  private checking = false;
  private readonly databaseGate = new BackgroundDatabaseGate('Campaign Scheduler');

  /**
   * Start the campaign scheduler
   * Checks for scheduled campaigns every five seconds
   */
  start() {
    if (this.isRunning) {
      console.log('Campaign scheduler is already running');
      return;
    }

    console.log('Starting campaign scheduler...');
    this.isRunning = true;

    // Run every five seconds
    this.task = cron.schedule('*/5 * * * * *', async () => {
      await this.checkScheduledCampaigns();
    });

    console.log('Campaign scheduler started successfully');
  }

  /**
   * Check for campaigns that are scheduled to run now
   */
  private async checkScheduledCampaigns() {
    if (this.checking) return;
    this.checking = true;
    try {
      if (!await this.databaseGate.check(() => checkDatabaseSchema(db, backgroundSchemas['campaign-execution'])) || !this.isRunning) return;

      await reconcileFailedCampaignJobs();
      const campaigns = await CampaignModel.getScheduledCampaigns();

      if (campaigns.length === 0) {
        return;
      }
      console.log(`[Campaign Scheduler] Found ${campaigns.length} scheduled campaign(s) ready to execute`);

      // Start each campaign
      for (const campaign of campaigns) {
        try {
          console.log(`[Campaign Scheduler] Starting campaign: ${campaign.id} - ${campaign.name} (scheduled at: ${campaign.scheduled_at})`);
          const result = await CampaignService.startCampaign(campaign.id);
          console.log(`[Campaign Scheduler] Campaign ${campaign.id} queued successfully:`, result);
        } catch (error: any) {
          if (getDatabaseFailure(error)) throw error;
          reportBackgroundError('Campaign Scheduler', error, { campaignId: campaign.id });
          // Leave scheduled work available for the next scan if queueing fails.
        }
      }
    } catch (error: any) {
      this.databaseGate.fail(error);
    } finally {
      this.checking = false;
    }
  }

  /**
   * Stop the scheduler (for graceful shutdown)
   */
  stop() {
    this.task?.stop();
    this.task?.destroy();
    this.task = undefined;
    this.isRunning = false;
    console.log('Campaign scheduler stopped');
  }
}

export default new CampaignSchedulerService();
