import CampaignModel from '../models/campaign.model';
import { campaignExecutionQueue } from '../../queues/campaignExecution.queue';

// BullMQ can fail a stalled job without entering the processor's catch block.
export async function reconcileFailedCampaignJobs() {
  const campaigns = await CampaignModel.getCampaignsForReconciliation();
  for (const campaign of campaigns) {
    try {
      const redis = await campaignExecutionQueue.client;
      // A recipient is marked terminal before Meta returns; wait for the live sender.
      if (await redis.get(`campaign-execution-lock:${campaign.id}`)) continue;
      if (await CampaignModel.completeIfNoPendingMessages(campaign.id)) {
        console.info('[Campaign Recovery] Completed campaign with no pending recipients', { campaignId: campaign.id });
        continue;
      }
      // Never restart a failed campaign or reset any recipient during reconciliation.
      if (campaign.status === 'failed') continue;
      const job = await campaignExecutionQueue.getJob(campaign.id);
      if (!job) {
        console.warn('[Campaign Recovery] Job not visible; preserving running campaign', { campaignId: campaign.id });
        continue;
      }
      if (await job.getState() !== 'failed') continue;
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
