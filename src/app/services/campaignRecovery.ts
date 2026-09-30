import CampaignModel from '../models/campaign.model';
import { campaignExecutionQueue } from '../../queues/campaignExecution.queue';

// BullMQ can fail a stalled job without entering the processor's catch block.
export async function reconcileFailedCampaignJobs() {
  const campaigns = await CampaignModel.getRunningCampaigns();
  for (const campaign of campaigns) {
    try {
      const job = await campaignExecutionQueue.getJob(campaign.id);
      if (!job) {
        await CampaignModel.markRunningJobFailed(campaign.id, 'Campaign execution job missing; automatic recovery is disabled');
        continue;
      }
      if (await job.getState() !== 'failed') continue;
      if (await CampaignModel.completeIfNoPendingMessages(campaign.id)) {
        console.info('[Campaign Recovery] Completed campaign with no pending recipients despite failed job', { campaignId: campaign.id, jobId: job.id });
        continue;
      }
      // Preserve an operator pause or a concurrent status change.
      await CampaignModel.markRunningJobFailed(campaign.id, job.failedReason || 'Campaign job failed without a reported reason');
      console.error('[Campaign Recovery] Job exhausted or stalled; campaign marked failed', {
        campaignId: campaign.id, jobId: job.id, reason: job.failedReason,
        attempts: job.attemptsMade, stacktrace: job.stacktrace,
      });
    } catch (error) {
      console.error('[Campaign Recovery] Status reconciliation failed', { campaignId: campaign.id, error });
    }
  }
}
