import { getMessageError } from '@surefy/console/app/utils/messageError';
import { Worker, Job, DelayedError } from 'bullmq';
import { campaignExecutionQueue } from '../campaignExecution.queue';
import { campaignCapacity, createCapacitySampler } from '../campaignCapacity';
import { waitForCampaignPermit, getCampaignSenderCooldown, setCampaignSenderCooldown, setCampaignPairCooldown } from '../campaignPacing';
import { acquireCampaignUserSlot, refreshCampaignUserSlot, releaseCampaignUserSlot } from '../campaignUserSlots';
import { isConnectionAcquireError } from '../campaignDatabaseError';
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
class CampaignProviderLimitError extends Error {
  constructor(public readonly code: string, message: string, public readonly recipient: string) { super(message); }
}
const providerLimitCodes = new Set(['130429', '131056', '80007', '80008', '4', '17', '32', '613']);
const capacitySampler = createCapacitySampler();
const healthTimer = setInterval(() => {
  capacitySampler.sample();
  console.info('[Campaign Worker] Health', { ...capacitySampler.metrics(), concurrency: campaignCapacity.concurrency, messageConcurrency: campaignCapacity.messageConcurrency, maxRunningPerUser: campaignCapacity.maxRunningPerUser, messagesPerSecond: campaignCapacity.messagesPerSecond });
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
  let slotUserId: string | undefined;
  let releaseSlot = false;
  let phase = 'loading campaign';
  const heartbeat = setInterval(() => {
    void redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], 120000) else return 0 end",
      1, lockKey, lockOwner).then(value => { if (!value) lockLost = true; }).catch(() => { lockLost = true; });
    if (slotUserId) void refreshCampaignUserSlot(slotUserId, campaignId)
      .then(ok => { if (!ok) lockLost = true; }).catch(() => { lockLost = true; });
  }, 10000);
  heartbeat.unref();
  try {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign || campaign.deleted_at) return { status: 'removed' };
    if (campaign.company_id !== companyId) throw new Error('Campaign does not belong to company');
    if (['paused', 'completed'].includes(campaign.status)) {
      await releaseCampaignUserSlot(campaign.user_id, campaignId);
      return { status: campaign.status };
    }
    if (campaign.status === 'scheduled' && campaign.scheduled_at && new Date(campaign.scheduled_at).getTime() > Date.now()) {
      console.info('[Campaign Worker] Waiting for schedule', { campaignId, scheduledAt: campaign.scheduled_at });
      return await defer(new Date(campaign.scheduled_at).getTime() - Date.now());
    }
    phase = 'acquiring user slot';
    if (!await acquireCampaignUserSlot(campaign.user_id, campaignId)) {
      console.info('[Campaign Worker] Waiting for user campaign slot', { campaignId, userId: campaign.user_id, limit: campaignCapacity.maxRunningPerUser });
      return await defer(5000);
    }
    slotUserId = campaign.user_id;
    phase = 'loading campaign configuration';
    if (campaign.status !== 'running') {
      await CampaignModel.updateStatus(campaignId, 'running', { started_at: campaign.started_at || new Date() });
    }
    const template = await TemplateModel.findById(campaign.template_id);
    if (!template) throw new Error('Template not found');
    const phone = await PhoneNumberModel.findByPhoneNumberId(campaign.phone_number_id);
    if (!phone) throw new Error('Business phone number not found');
    campaign.phone_number_id = phone.phone_number_id;
    const senderCooldown = await getCampaignSenderCooldown(campaign.phone_number_id);
    if (senderCooldown > 0) {
      console.info('[Campaign Worker] Waiting for sender cooldown', { campaignId, phoneNumberId: campaign.phone_number_id, delayMs: senderCooldown });
      return await defer(senderCooldown);
    }
    const batchSize = capacitySampler.sample();
    console.info('[Campaign Worker] Batch starting', { campaignId, jobId: job.id, attempt: job.attemptsMade + 1, ...capacitySampler.metrics() });
    phase = 'selecting recipients';
    const pending = job.data.status === 'failed'
      ? await CampaignMessageModel.getFailedMessages(campaignId, batchSize, new Date(job.timestamp))
      : await CampaignMessageModel.getPendingMessages(campaignId, batchSize, job.data.status, job.data.error_message);
    if (!pending.length) {
      phase = 'completing campaign';
      const counts = await CampaignMessageModel.getCampaignStats(campaignId);
      // Recipient failures are reported in the counts; they do not fail the execution.
      await CampaignModel.updateStatus(campaignId, 'completed', { completed_at: new Date() });
      releaseSlot = true;
      console.info('[Campaign Worker] Finished', { campaignId, status: 'completed', counts, errorCounts: job.data.errorCounts });
      return { status: 'completed' };
    }
    const contacts = await ContactModel.findCampaignRecipients(pending.map((message: any) => message.contact_id));
    const contactsById = new Map(contacts.map((contact: any) => [contact.id, contact]));
    const results: PromiseSettledResult<void>[] = [];
    phase = 'sending recipients';
    for (let offset = 0; offset < pending.length; offset += campaignCapacity.messageConcurrency) {
      const currentCampaign = await CampaignModel.findById(campaignId);
      if (currentCampaign?.status !== 'running') {
        releaseSlot = true;
        return { status: currentCampaign?.status };
      }
      const chunk = pending.slice(offset, offset + campaignCapacity.messageConcurrency);
      const settled = await Promise.allSettled(chunk.map(async (message: any) => {
        if (lockLost) throw new CampaignInfrastructureError('Campaign execution lock lost');
        return sendCampaignMessage(campaign, message, contactsById.get(message.contact_id), template, phone, () => !lockLost);
      }));
      results.push(...settled);
      const infrastructureFailure = settled.find(result => result.status === 'rejected' && result.reason instanceof CampaignInfrastructureError);
      if (infrastructureFailure?.status === 'rejected') throw infrastructureFailure.reason;
      const providerLimit = settled.find(result => result.status === 'rejected' && result.reason instanceof CampaignProviderLimitError);
      if (providerLimit?.status === 'rejected') {
        const delayMs = providerLimit.reason.code === '131056' ? 6000 : 30000;
        if (providerLimit.reason.code === '131056') {
          await setCampaignPairCooldown(campaign.phone_number_id, providerLimit.reason.recipient, delayMs);
        } else {
          await setCampaignSenderCooldown(campaign.phone_number_id, delayMs);
        }
        console.warn('[Campaign Worker] Provider limit; recipients remain pending', { campaignId, phoneNumberId: campaign.phone_number_id, code: providerLimit.reason.code, delayMs });
        return await defer(delayMs);
      }
    }
    const errors = { ...(job.data.errorCounts || {}) };
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      const failure = getMessageError(result.reason);
      const key = JSON.stringify([failure.error_code, failure.error_message]);
      errors[key] = (errors[key] || 0) + 1;
    }
    // Preserve counters across yielded batches without unbounded unique error storage.
    const errorCounts = Object.fromEntries(Object.entries(errors).sort((a,b) => b[1]-a[1]).slice(0,100));
    phase = 'updating progress';
    // Counting every pending row after every small batch becomes quadratic for large campaigns.
    const checkProgress = job.data.status !== 'failed' && Date.now() - (job.data.progressCheckedAt || 0) >= 20000;
    const pendingCount = checkProgress ? await CampaignMessageModel.getPendingCount(campaignId) : undefined;
    const progress = pendingCount === undefined ? undefined : Math.min(100, Math.round((campaign.total_recipients - pendingCount) / Math.max(1, campaign.total_recipients) * 100));
    if (progress !== undefined) await job.updateProgress(progress);
    await job.updateData({ ...job.data, errorCounts, progressCheckedAt: checkProgress ? Date.now() : job.data.progressCheckedAt });
    console.info('[Campaign Worker] Batch finished', { campaignId, jobId: job.id, durationMs: Date.now() - batchStartedAt, selected: pending.length, rejected: results.filter(r => r.status === 'rejected').length, pendingCount, progress, errorCounts, ...capacitySampler.metrics() });
    await job.log(`Batch size ${batchSize}; selected ${pending.length}; pending ${pendingCount ?? 'retry'}; progress ${progress ?? 'retry'}%`);
    const current = await CampaignModel.findById(campaignId);
    if (current?.status !== 'running') {
      releaseSlot = true;
      return { status: current?.status };
    }
    return await defer(campaignCapacity.yieldMs);
  } catch (error) {
    if (error instanceof DelayedError) throw error;
    if (isConnectionAcquireError(error)) {
      console.warn('[Campaign Worker] Database pool exhausted; retrying batch without failing campaign', {
        campaignId, jobId: job.id, userId: slotUserId, phase, delayMs: 30000,
        reason: error instanceof Error ? error.message : String(error),
      });
      return await defer(30000);
    }
    console.error('[Campaign Worker] Execution error', { campaignId, jobId: job.id, phase, attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts, error: getMessageError(error), stack: error instanceof Error ? error.stack : undefined });
    if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
      const current = await CampaignModel.findById(campaignId);
      if (current?.company_id === companyId && current.status === 'running') {
        console.error('[Campaign Worker] Campaign failed after exhausted retries', { campaignId, jobId: job.id, reason: getMessageError(error) });
        const failure = getMessageError(error);
        await CampaignModel.updateStatus(campaignId, 'failed', {
          failure_reason: `${phase}: ${failure.error_code}: ${failure.error_message}`,
        });
        releaseSlot = true;
      }
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (releaseSlot && slotUserId) await releaseCampaignUserSlot(slotUserId, campaignId)
      .catch(error => console.error('[Campaign Worker] User slot release failed; expires automatically', { campaignId, error }));
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, lockKey, lockOwner)
      .catch(error => console.error('[Campaign Worker] Lock release failed; expires automatically', { campaignId, message: error.message }));
  }
}

async function sendCampaignMessage(campaign: any, campaignMessage: any, contact: any, template: any, phone: any, ownsLock: () => boolean) {
  let infrastructureOperation = true;
  let recipientPhone = '';
  try {
    if (!contact) {
      await CampaignMessageModel.updateStatus(campaignMessage.id, 'skipped', {
        error_message: 'Contact not found',
      });
      return;
    }
    recipientPhone = contact.phone_number;

    // Skip invalid numbers
    if (!contact.is_valid) {
      await CampaignMessageModel.updateStatus(campaignMessage.id, 'skipped', {
        error_message: `Invalid number: ${contact.invalid_reason}`,
      });
      await CampaignModel.incrementCount(campaign.id, 'invalid_numbers_count');
      return;
    }

    infrastructureOperation = false;
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
    }, { phoneNumber: phone, templateRecord: template });

    infrastructureOperation = true;
    await CampaignMessageModel.recordSent(campaignMessage.id, campaign.id, contact.id, message.id, Number(message.cost || 0));
  } catch (error: any) {
    if (isConnectionAcquireError(error)) {
      console.warn('[Campaign Worker] Recipient database connection unavailable', { campaignId: campaign.id, campaignMessageId: campaignMessage.id, reason: error.message });
      throw new CampaignInfrastructureError(error.message);
    }
    if (!infrastructureOperation) {
      const failure = getMessageError(error);
      if (providerLimitCodes.has(failure.error_code)) {
        console.warn('[Campaign Worker] Provider temporarily rejected send; recipient remains pending', { campaignId: campaign.id, campaignMessageId: campaignMessage.id, code: failure.error_code, reason: failure.error_message });
        throw new CampaignProviderLimitError(failure.error_code, failure.error_message, recipientPhone);
      }
    }
    if (infrastructureOperation) {
      console.error('[Campaign Worker] Recipient infrastructure error', { campaignId: campaign.id, campaignMessageId: campaignMessage.id, error });
      throw new CampaignInfrastructureError(error instanceof Error ? error.message : String(error));
    }
    console.error('[Campaign Worker] Recipient send failed', { campaignId: campaign.id, campaignMessageId: campaignMessage.id, contactId: campaignMessage.contact_id, reason: getMessageError(error), stack: error instanceof Error ? error.stack : undefined });

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
            parameters: [{ type: 'image', image: media.media_id ? { id: media.media_id } : { link: media.link || media.url } }],
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
            parameters: [{ type: 'video', video: media.media_id ? { id: media.media_id } : { link: media.link || media.url } }],
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
          const docObj: any = media.media_id ? { id: media.media_id } : { link: media.link || media.url };
          if (media.filename || media.name) {
            docObj.filename = media.filename || media.name;
          }
          components.push({
            type: 'header',
            parameters: [{ type: 'document', document: docObj }],
          });
        } else if (component.example?.header_handle?.[0]) {
          components.push({
            type: 'header',
            parameters: [{ type: 'document', document: { link: media?.link || component.example.header_handle[0] } }],
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
  console.error('[Campaign Worker] Job attempt failed', { jobId: job?.id, campaignId: job?.data.campaignId, attempt: job?.attemptsMade, maxAttempts: job?.opts.attempts, reason: getMessageError(err), stack: err.stack });
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
