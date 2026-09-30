import CampaignModel from '../models/campaign.model';
import { campaignExecutionQueue } from '../../queues/campaignExecution.queue';

// BullMQ can fail a stalled job without entering the processor's catch block.
export async function reconcileFailedCampaignJobs() {
  const campaigns = await CampaignModel.getRunningCampaigns();
  for (const campaign of campaigns) {
    try {
      const job = await campaignExecutionQueue.getJob(campaign.id);
      if (!job) {
        // A scheduler may be connected to a different Redis DB/instance than the
        // worker. Absence here is not evidence that execution has stopped.
        // Do not enqueue a duplicate job or overwrite the worker's running status.
        console.warn('[Campaign Recovery] Job not visible; preserving running campaign', { campaignId: campaign.id });
        continue;
      }
      if (await job.getState() !== 'failed') continue;
      const redis = await campaignExecutionQueue.client;
      if (await redis.get(`campaign-execution-lock:${campaign.id}`)) continue;
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
