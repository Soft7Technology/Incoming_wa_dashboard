// campaign.service.ts

import CampaignModel from "@surefy/console/models/campaign.model";
import { HTTP404Error, HTTP400Error } from "@surefy/core/errors";
import { campaignRetryQueue } from "../queues/campaignRetry.queue";

async retryFailedCampaign(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);

    if (!campaign) {
        throw new HTTP404Error({
            message: "Campaign not found",
        });
    }

    // Check if there are failed messages
    const failedCount = await CampaignMessageModel.query()
        .where("campaign_id", campaignId)
        .where("status", "failed")
        .resultSize();

    if (failedCount === 0) {
        throw new HTTP400Error({
            message: "No failed messages found for retry",
        });
    }

    // Prevent duplicate retry jobs
    const existingJob = await campaignRetryQueue.getJob(
        `retry-${campaignId}`
    );

    if (existingJob) {
        const state = await existingJob.getState();

        if (
            state === "waiting" ||
            state === "active" ||
            state === "delayed"
        ) {
            return {
                message: "Retry job already queued",
                campaign_id: campaignId,
                status: state,
            };
        }
    }

    await campaignRetryQueue.add(
        `retry-campaign-${campaignId}`,
        {
            campaignId,
            userId: campaign.user_id,
            companyId: campaign.company_id,
        },
        {
            jobId: `retry-${campaignId}`,
        }
    );

    return {
        message: "Failed campaign messages queued for retry",
        campaign_id: campaignId,
        failed_messages: failedCount,
        status: "queued",
    };
}