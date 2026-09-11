import CampaignModel from '../models/campaign.model';
import { campaignExecutionQueue } from '../../queues/campaignExecution.queue';

// BullMQ can fail a stalled job without entering the processor's catch block.
export async function reconcileFailedCampaignJobs() {
  const campaigns = await CampaignModel.getRunningCampaigns();
  for (const campaign of campaigns) {
    try {
      const job = await campaignExecutionQueue.getJob(campaign.id);
      if (!job || await job.getState() !== 'failed') continue;
      // Preserve an operator pause or a concurrent status change.
      await CampaignModel.markRunningJobFailed(campaign.id);
      console.error('[Campaign Recovery] Job exhausted or stalled; campaign marked failed', {
        campaignId: campaign.id, reason: job.failedReason, attempts: job.attemptsMade,
      });
    } catch (error) {
      console.error('[Campaign Recovery] Status reconciliation failed', { campaignId: campaign.id, error });
    }
  }
}
