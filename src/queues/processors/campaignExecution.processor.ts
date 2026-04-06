import { Worker, Job } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';
import { CampaignExecutionJobData } from '../campaignExecution.queue';
import CampaignModel from '@surefy/console/models/campaign.model';
import CampaignMessageModel from '@surefy/console/models/campaignMessage.model';
import ContactModel from '@surefy/console/models/contact.model';
import TemplateModel from '@surefy/console/models/template.model';
import MessageService from '@surefy/console/services/message.service';
import * as os from 'os';
import { v4 as uuidv4 } from "uuid";


const BATCH_SIZE = 50; // Process 50 messages at a time
const DELAY_BETWEEN_BATCHES = 2000; // 2 seconds delay between batches

async function processCampaignExecution(job: Job<CampaignExecutionJobData>) {
  const { campaignId,userId, companyId } = job.data;

  try {
    console.log(`[Job ${job.id}] Starting campaign execution: ${campaignId}`);

    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    if (campaign.company_id !== companyId) {
      throw new Error('Campaign does not belong to company');
    }

    // Update campaign status to running
    await CampaignModel.updateStatus(campaignId, 'running', {
      started_at: new Date(),
    });

    // Get template
    const template = await TemplateModel.findById(campaign.template_id);
    if (!template) {
      throw new Error('Template not found');
    }

    let hasMore = true;
    let processedCount = 0;

    while (hasMore) {
      // Check if campaign should still be running
      const currentCampaign = await CampaignModel.findById(campaignId);
      if (currentCampaign.status !== 'running') {
        console.log(`[Campaign ${campaignId}] Stopped by user, status: ${currentCampaign.status}`);
        break;
      }

      // Get pending messages
      const pendingMessages = await CampaignMessageModel.getPendingMessages(campaignId, BATCH_SIZE);

      if (pendingMessages.length === 0) {
        hasMore = false;
        await CampaignModel.updateStatus(campaignId, 'completed', {
          completed_at: new Date(),
        });

        console.log(`[Campaign ${campaignId}] Completed successfully`);
        break;
      }

      // Process messages in batch
      const results = await Promise.allSettled(
        pendingMessages.map(async (campaignMessage) => {
          return await sendCampaignMessage(campaign, campaignMessage, template);
        })
      );

      // Count results
      const successful = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      processedCount += pendingMessages.length;

      // Update job progress
      const progress = Math.round((processedCount / campaign.total_recipients) * 100);
      await job.updateProgress(progress);

      console.log(
        `[Campaign ${campaignId}] Batch processed: ${successful} successful, ${failed} failed. Progress: ${progress}%`
      );

      // Delay between batches to avoid rate limiting
      if (pendingMessages.length === BATCH_SIZE) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    console.log(`[Campaign ${campaignId}] Execution completed. Processed ${processedCount} messages`);

    return {
      campaign_id: campaignId,
      processed: processedCount,
      status: 'completed',
    };
  } catch (error: any) {
    console.error(`[Campaign ${campaignId}] Fatal error:`, error);

    // Mark campaign as failed
    await CampaignModel.updateStatus(campaignId, 'failed', {
      completed_at: new Date(),
    });

    throw error;
  }
}

async function sendCampaignMessage(campaign: any, campaignMessage: any, template: any) {
  try {
    // Get contact
    const contact = await ContactModel.findById(campaignMessage.contact_id);
    if (!contact) {
      await CampaignMessageModel.updateStatus(campaignMessage.id, 'skipped', {
        error_message: 'Contact not found',
      });
      return;
    }

    // Skip invalid numbers
    if (!contact.is_valid) {
      await CampaignMessageModel.updateStatus(campaignMessage.id, 'skipped', {
        error_message: `Invalid number: ${contact.invalid_reason}`,
      });
      await CampaignModel.incrementCount(campaign.id, 'invalid_numbers_count');
      return;
    }

    // Build template payload
    const templatePayload = buildTemplatePayload(
      template,
      campaignMessage.template_variables,
      campaign.media_uploads
    );

    const messageUUID = uuidv4();

    // Send message via MessageService
    const message = await MessageService.sendMessage({
      messageUUID,
      user_id:campaign.user_id,
      profile_name: contact.name,
      campaign_id:campaign.id,
      phone_number_id: campaign.phone_number_id,
      to: contact.phone_number,
      type: 'template',
      template: templatePayload,
    });

    // Update campaign message status
    await CampaignMessageModel.updateStatus(campaignMessage.id, 'sent', {
      message_id: message.id,
    });

    // Update campaign counts
    await CampaignModel.incrementCount(campaign.id, 'sent_count');
    await CampaignModel.updateCounts(campaign.id, {
      total_cost: Number(campaign.total_cost || 0) + Number(message.cost || 0),
    });

    // Update contact stats
    await ContactModel.incrementMessageCount(contact.id);
  } catch (error: any) {
    console.error(`Failed to send campaign message ${campaignMessage.id}:`, error);

    await CampaignMessageModel.updateStatus(campaignMessage.id, 'failed', {
      error_message: error?.message || 'Unknown error',
      error_code: error?.code || 'UNKNOWN',
    });

    await CampaignModel.incrementCount(campaign.id, 'failed_count');

    // Update contact failed count
    if (campaignMessage.contact_id) {
      await ContactModel.incrementFailedCount(campaignMessage.contact_id);
    }

    throw error; // Re-throw to mark as failed in batch results
  }
}

function buildTemplatePayload(template: any, variables: Record<string, any>, mediaUploads: any[] = []) {
  const components = [];

  // Process template components
  if (template.components) {
    for (const component of template.components) {
      if (component.type === 'HEADER' && component.format === 'IMAGE') {
        const media = mediaUploads.find((m: any) => m.type === 'image');
        if (media) {
          components.push({
            type: 'header',
            parameters: [{ type: 'image', image: { id: media.media_id } }],
          });
        } else if (component.example?.header_handle?.[0]) {
          components.push({
            type: 'header',
            parameters: [{ type: 'image', image: { link: component.example.header_handle[0] } }],
          });
        }
      } else if (component.type === 'HEADER' && component.format === 'VIDEO') {
        const media = mediaUploads.find((m: any) => m.type === 'video');
        if (media) {
          components.push({
            type: 'header',
            parameters: [{ type: 'video', video: { id: media.media_id } }],
          });
        } else if (component.example?.header_handle?.[0]) {
          components.push({
            type: 'header',
            parameters: [{ type: 'video', video: { link: component.example.header_handle[0] } }],
          });
        }
      } else if (component.type === 'HEADER' && component.format === 'DOCUMENT') {
        const media = mediaUploads.find((m: any) => m.type === 'document');
        if (media) {
          components.push({
            type: 'header',
            parameters: [{ type: 'document', document: { id: media.media_id } }],
          });
        } else if (component.example?.header_handle?.[0]) {
          components.push({
            type: 'header',
            parameters: [{ type: 'document', document: { link: component.example.header_handle[0] } }],
          });
        }
      } else if (component.type === 'BODY' && component.text) {
        // Extract variables from body text {{1}}, {{2}}, etc.
        const bodyVariables = extractTemplateVariables(component.text);
        if (bodyVariables.length > 0) {
          const parameters = bodyVariables.map((varName: string) => ({
            type: 'text',
            text: variables[varName] || '',
          }));

          components.push({
            type: 'body',
            parameters,
          });
        }
      }
    }
  }

  return {
    name: template.name,
    language: template.language,
    components: components.length > 0 ? components : undefined,
  };
}

function extractTemplateVariables(text: string): string[] {
  const regex = /\{\{(\d+)\}\}/g;
  const matches = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

// Create and start the worker
console.log('📦 Initializing Campaign Execution Worker...');
console.log('📡 Redis config:', {
  host: redisConfig.host,
  port: redisConfig.port,
  db: redisConfig.db,
});

export const campaignExecutionWorker = new Worker<CampaignExecutionJobData>(
  'campaign-execution',
  async (job) => {
    console.log(`🔄 Processing campaign job ${job.id}...`);
    return await processCampaignExecution(job);
  },
  {
    connection: redisConfig,
    concurrency: 1, // Process 1 campaign at a time to avoid rate limits
    limiter: {
      max: 1, // Max 1 job
      duration: 1000, // per second
    },
  }
);

campaignExecutionWorker.on('completed', (job) => {
  console.log(`✅ Campaign job ${job.id} completed successfully`);
});

campaignExecutionWorker.on('failed', (job, err) => {
  console.error(`❌ Campaign job ${job?.id} failed:`, err.message);
  console.error('Stack:', err.stack);
});

campaignExecutionWorker.on('error', (error) => {
  console.error('❌ Campaign Execution Worker Error:', error);
});

campaignExecutionWorker.on('ready', () => {
  console.log('✅ Campaign Execution Worker is ready and listening for jobs');
});

campaignExecutionWorker.on('active', (job) => {
  console.log(`🔄 Campaign job ${job.id} is now active`);
});

console.log('🚀 Campaign Execution Worker started and waiting for jobs...');