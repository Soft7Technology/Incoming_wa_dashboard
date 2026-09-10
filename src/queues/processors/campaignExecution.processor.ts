import { getMessageError } from '@surefy/console/app/utils/messageError';
import { Worker, Job, DelayedError } from 'bullmq';
import { campaignExecutionQueue } from '../campaignExecution.queue';
import { campaignCapacity, createCapacitySampler } from '../campaignCapacity';
import { waitForCampaignPermit } from '../campaignPacing';
import PhoneNumberModel from '../../app/models/phoneNumber.model';
import redisConfig from '@surefy/config/redis.config';
import { CampaignExecutionJobData } from '../campaignExecution.queue';
import CampaignModel from '@surefy/console/models/campaign.model';
import CampaignMessageModel from '@surefy/console/models/campaignMessage.model';
import ContactModel from '@surefy/console/models/contact.model';
import TemplateModel from '@surefy/console/models/template.model';
import MessageService from '@surefy/console/services/message.service';
import { v4 as uuidv4 } from "uuid";


class CampaignInfrastructureError extends Error {}
const capacitySampler = createCapacitySampler();
const healthTimer = setInterval(() => {
  capacitySampler.sample();
  console.info('[Campaign Worker] Health', { ...capacitySampler.metrics(), concurrency: campaignCapacity.concurrency, messagesPerSecond: campaignCapacity.messagesPerSecond });
}, 15000);
healthTimer.unref();

export async function processCampaignExecution(job: Job<CampaignExecutionJobData>, token?: string) {
  const { campaignId, companyId } = job.data;
  const batchStartedAt = Date.now();
  const redis = await campaignExecutionQueue.client;
  const lockKey = `campaign-execution-lock:${campaignId}`;
  const lockOwner = uuidv4();
  const defer = async (delay: number): Promise<never> => {
    await job.moveToDelayed(Date.now() + delay, token);
    throw new DelayedError();
  };
  if (!await redis.set(lockKey, lockOwner, 'PX', 120000, 'NX')) return defer(1000);
  let lockLost = false;
  const heartbeat = setInterval(() => {
    void redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], 120000) else return 0 end",
      1, lockKey, lockOwner).then(value => { if (!value) lockLost = true; }).catch(() => { lockLost = true; });
  }, 10000);
  heartbeat.unref();
  try {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign || campaign.deleted_at) return { status: 'removed' };
    if (campaign.company_id !== companyId) throw new Error('Campaign does not belong to company');
    if (['paused', 'completed'].includes(campaign.status)) return { status: campaign.status };
    if (campaign.status === 'scheduled' && campaign.scheduled_at && new Date(campaign.scheduled_at).getTime() > Date.now()) {
      console.info('[Campaign Worker] Waiting for schedule', { campaignId, scheduledAt: campaign.scheduled_at });
      return await defer(new Date(campaign.scheduled_at).getTime() - Date.now());
    }
    if (campaign.status !== 'running') {
      await CampaignModel.updateStatus(campaignId, 'running', { started_at: campaign.started_at || new Date() });
    }
    const template = await TemplateModel.findById(campaign.template_id);
    if (!template) throw new Error('Template not found');
    const phone = await PhoneNumberModel.findByPhoneNumberId(campaign.phone_number_id);
    if (!phone) throw new Error('Business phone number not found');
    campaign.phone_number_id = phone.phone_number_id;
    const batchSize = capacitySampler.sample();
    console.info('[Campaign Worker] Batch starting', { campaignId, jobId: job.id, attempt: job.attemptsMade + 1, ...capacitySampler.metrics() });
    const pending = job.data.status === 'failed'
      ? await CampaignMessageModel.getFailedMessages(campaignId, batchSize, new Date(job.timestamp))
      : await CampaignMessageModel.getPendingMessages(campaignId, batchSize, job.data.status, job.data.error_message);
    if (!pending.length) {
      const counts = await CampaignMessageModel.getCampaignStats(campaignId);
      const finalStatus = Number(counts.failed_count) > 0 && Number(counts.sent_count) + Number(counts.delivered_count) + Number(counts.read_count) === 0
        ? 'failed' : 'completed';
      await CampaignModel.updateStatus(campaignId, finalStatus, { completed_at: new Date() });
      console.info('[Campaign Worker] Finished', { campaignId, status: finalStatus, counts });
      return { status: finalStatus };
    }
    const results = await Promise.allSettled(pending.map(async (message: any) => {
      if (lockLost) throw new Error('Campaign execution lock lost');
      return sendCampaignMessage(campaign, message, template, () => !lockLost);
    }));
    const errors = { ...(job.data.errorCounts || {}) };
    let pause = false;
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      if (result.reason instanceof CampaignInfrastructureError) throw result.reason;
      const failure = getMessageError(result.reason);
      const key = JSON.stringify([failure.error_code, failure.error_message]);
      errors[key] = (errors[key] || 0) + 1;
      if (errors[key] > 10 || ['130429', '131056', '80007', '80008', '4', '17', '32', '613'].includes(failure.error_code)) pause = true;
    }
    // Preserve counters across yielded batches without unbounded unique error storage.
    const errorCounts = Object.fromEntries(Object.entries(errors).sort((a,b) => b[1]-a[1]).slice(0,100));
    await job.updateData({ ...job.data, errorCounts });
    const counts = await CampaignMessageModel.getCampaignStats(campaignId);
    const progress = Math.min(100, Math.round((campaign.total_recipients - Number(counts.pending_count)) / Math.max(1,campaign.total_recipients) * 100));
    await job.updateProgress(progress);
    console.info('[Campaign Worker] Batch finished', { campaignId, durationMs: Date.now() - batchStartedAt, selected: pending.length, rejected: results.filter(r => r.status === 'rejected').length, progress, counts, ...capacitySampler.metrics() });
    await job.log(`Batch size ${batchSize}; selected ${pending.length}; progress ${progress}%`);
    const current = await CampaignModel.findById(campaignId);
    if (current?.status !== 'running') return { status: current?.status };
    if (pause) {
      await CampaignModel.updateStatus(campaignId, 'paused');
      console.warn('[Campaign Worker] Paused: provider limit or repeated errors', { campaignId, errorCounts });
      await job.log('Paused for provider rate limit or more than 10 matching errors. Inspect failed recipient details before resuming.');
      return { status: 'paused' };
    }
    return await defer(campaignCapacity.yieldMs);
  } catch (error) {
    if (error instanceof DelayedError) throw error;
    console.error('[Campaign Worker] Execution error', { campaignId, attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts, error: getMessageError(error) });
    if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
      const current = await CampaignModel.findById(campaignId);
      if (current?.company_id === companyId && current.status === 'running') await CampaignModel.updateStatus(campaignId, 'failed');
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, lockKey, lockOwner)
      .catch(error => console.error('[Campaign Worker] Lock release failed; expires automatically', { campaignId, message: error.message }));
  }
}

async function sendCampaignMessage(campaign: any, campaignMessage: any, template: any, ownsLock: () => boolean) {
  let infrastructureOperation = false;
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

    infrastructureOperation = true;
    if (!await waitForCampaignPermit(campaign.phone_number_id, contact.phone_number)) return;
    if (!ownsLock()) return;
    const current = await CampaignModel.findById(campaign.id);
    if (current?.status !== 'running') return;

    infrastructureOperation = false;
    // Send message via MessageService
    const message = await MessageService.sendMessage({
      messageUUID,
      user_id: campaign.user_id,
      company_id: campaign.company_id,
      profile_name: contact.name,
      campaign_id: campaign.id,
      phone_number_id: campaign.phone_number_id,
      to: contact.phone_number,
      type: 'template',
      template: templatePayload,
    });

    await CampaignMessageModel.recordSent(campaignMessage.id, campaign.id, contact.id, message.id, Number(message.cost || 0));
  } catch (error: any) {
    if (infrastructureOperation) throw new CampaignInfrastructureError(error.message);
    console.error(`Failed to send campaign message ${campaignMessage.id}:`, error);

    await CampaignMessageModel.updateStatus(campaignMessage.id, 'failed', {
      ...getMessageError(error),
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
            parameters: [{ type: 'image', image: { link: media.link } }],
          });
        } else if (component.example?.header_handle?.[0]) {
          components.push({
            type: 'header',
            parameters: [{ type: 'image', image: { link: media.link } }],
          });
        }
      } else if (component.type === 'HEADER' && component.format === 'VIDEO') {
        const media = mediaUploads.find((m: any) => m.type === 'video');
        if (media) {
          components.push({
            type: 'header',
            parameters: [{ type: 'video', video: { link: media.link } }],
          });
        } else if (component.example?.header_handle?.[0]) {
          components.push({
            type: 'header',
            parameters: [{ type: 'video', video: { link: media.link } }],
          });
        }
      } else if (component.type === 'HEADER' && component.format === 'DOCUMENT') {
        const media = mediaUploads.find((m: any) => m.type === 'document');
        if (media) {
          components.push({
            type: 'header',
            parameters: [{ type: 'document', document: { link: media.link, filename: media.filename } }],
          });
        } else if (component.example?.header_handle?.[0]) {
          components.push({
            type: 'header',
            parameters: [{ type: 'document', document: { link: media.link } }],
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
  async (job, token) => {
    console.log(`🔄 Processing campaign job ${job.id}...`);
    return await processCampaignExecution(job, token);
  },
  {
    connection: redisConfig,
    concurrency: campaignCapacity.concurrency,
  }
);

campaignExecutionWorker.on('completed', (job) => {
  console.log(`✅ Campaign job ${job.id} completed successfully`);
});

campaignExecutionWorker.on('closed', () => { clearInterval(healthTimer); capacitySampler.close(); });
campaignExecutionWorker.on('stalled', jobId => console.warn('[Campaign Worker] Job stalled; BullMQ will recover it', { jobId }));

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
