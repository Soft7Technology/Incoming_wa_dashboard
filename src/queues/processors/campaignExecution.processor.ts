import { Worker, Job } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';
import { CampaignExecutionJobData } from '../campaignExecution.queue';

import CampaignModel from '@surefy/console/models/campaign.model';
import CampaignMessageModel from '@surefy/console/models/campaignMessage.model';
import ContactModel from '@surefy/console/models/contact.model';
import TemplateModel from '@surefy/console/models/template.model';
import MessageService from '@surefy/console/services/message.service';

/* ================= CONFIG ================= */

const BATCH_SIZE = 200;
const DELAY_BETWEEN_BATCHES = 60_000; // 1 minute

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function processCampaignExecution(job: Job<CampaignExecutionJobData>) {
  const { campaignId, companyId } = job.data;

  console.log(`🚀 Campaign started → ${campaignId}`);

  try {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) throw new Error('Campaign not found');
    if (campaign.company_id !== companyId) {
      throw new Error('Campaign-company mismatch');
    }

    await CampaignModel.updateStatus(campaignId, 'running', {
      started_at: new Date(),
    });

    const template = await TemplateModel.findById(campaign.template_id);
    if (!template) throw new Error('Template not found');

    let processedCount = 0;

    while (true) {
      const currentCampaign = await CampaignModel.findById(campaignId);
      if (currentCampaign.status !== 'running') {
        console.log(`⏹ Campaign stopped manually`);
        break;
      }

      const pendingMessages =
        await CampaignMessageModel.getPendingMessages(
          campaignId,
          BATCH_SIZE
        );
        
      console.log(`📝 Fetched ${pendingMessages.length} pending messages`);

      if (pendingMessages.length === 0) {
        await CampaignModel.updateStatus(campaignId, 'completed', {
          completed_at: new Date(),
        });
        console.log(`✅ Campaign completed`);
        break;
      }

      console.log(`📦 Sending batch of ${pendingMessages.length}`);

      let success = 0;
      let failed = 0;

      /* ===== SEQUENTIAL MESSAGE SENDING ===== */
      for (const campaignMessage of pendingMessages) {
        try {
          await sendCampaignMessage(
            campaign,
            campaignMessage,
            template
          );
          success++;
        } catch {
          failed++;
        }
      }

      processedCount += pendingMessages.length;

      const progress = Math.round(
        (processedCount / campaign.total_recipients) * 100
      );

      await job.updateProgress(progress);

      console.log(
        `📊 Batch finished → Success: ${success}, Failed: ${failed}, Progress: ${progress}%`
      );

      /* ===== HARD PAUSE AFTER FULL BATCH ===== */
      if (pendingMessages.length === BATCH_SIZE) {
        console.log(
          `⏸ Batch completed at ${new Date().toISOString()}`
        );
        console.log('⏳ Waiting 1 minute before next batch...');
        await sleep(DELAY_BETWEEN_BATCHES);
        console.log(
          `▶️ Resuming at ${new Date().toISOString()}`
        );
      }
    }

    return {
      campaign_id: campaignId,
      processed: processedCount,
      status: 'completed',
    };

  } catch (error) {
    console.error(`❌ Campaign failed`, error);

    await CampaignModel.updateStatus(campaignId, 'failed', {
      completed_at: new Date(),
    });

    throw error;
  }
}

/* ================= MESSAGE SENDING ================= */

async function sendCampaignMessage(
  campaign: any,
  campaignMessage: any,
  template: any
) {
  try {
    const contact = await ContactModel.findById(
      campaignMessage.contact_id
    );

    if (!contact) {
      await CampaignMessageModel.updateStatus(
        campaignMessage.id,
        'skipped',
        { error_message: 'Contact not found' }
      );
      return;
    }

    if (!contact.is_valid) {
      await CampaignMessageModel.updateStatus(
        campaignMessage.id,
        'skipped',
        { error_message: contact.invalid_reason }
      );
      await CampaignModel.incrementCount(
        campaign.id,
        'invalid_numbers_count'
      );
      return;
    }

    const templatePayload = buildTemplatePayload(
      template,
      campaignMessage.template_variables,
      campaign.media_uploads
    );

    const message = await MessageService.sendMessage({
      company_id: campaign.company_id,
      campaign_id: campaign.id,
      phone_number_id: campaign.phone_number_id,
      to: contact.phone_number,
      type: 'template',
      template: templatePayload,
    });

    await CampaignMessageModel.updateStatus(
      campaignMessage.id,
      'sent',
      { message_id: message.id }
    );

    await CampaignModel.incrementCount(
      campaign.id,
      'sent_count'
    );

    await CampaignModel.updateCounts(campaign.id, {
      total_cost:
        Number(campaign.total_cost || 0) +
        Number(message.cost || 0),
    });

  } catch (error: any) {
    await CampaignMessageModel.updateStatus(
      campaignMessage.id,
      'failed',
      {
        error_message: error?.message || 'Unknown error',
        error_code: error?.code || 'UNKNOWN',
      }
    );

    await CampaignModel.incrementCount(
      campaign.id,
      'failed_count'
    );

    if (campaignMessage.contact_id) {
      await ContactModel.incrementFailedCount(
        campaignMessage.contact_id
      );
    }

    throw error;
  }
}

/* ================= TEMPLATE HELPERS ================= */

function buildTemplatePayload(template: any, variables: Record<string, any>, mediaUploads: any[] = []) {
  const components = [];
  console.log('Building template payload with variables:', template, variables, mediaUploads,)

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
  console.log('Built template payload components:', JSON.stringify(components));

  return {
    name: template.name,
    language: template.language,
    components: components.length > 0 ? components : undefined,
  };
}

function extractTemplateVariables(text: string): string[] {
  const regex = /\{\{(\d+)\}\}/g;
  const vars: string[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    vars.push(match[1]);
  }

  return vars;
}

/* ================= WORKER ================= */

export const campaignExecutionWorker =
  new Worker<CampaignExecutionJobData>(
    'campaign-execution',
    async job => processCampaignExecution(job),
    {
      connection: redisConfig,
      concurrency: 1, // 🚫 NO limiter — batch logic controls speed
    }
  );

console.log('🚀 Campaign Execution Worker ready');

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
