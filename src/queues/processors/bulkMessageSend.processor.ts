import { Job, DelayedError } from 'bullmq';
import { isWorkerDraining } from '../../workers/drain';
import { createDatabaseAwareWorker } from '../databaseAwareWorker';
import { getDatabaseFailure, reportBackgroundError } from '@surefy/utils/databaseErrors';
import redisConfig from '@surefy/config/redis.config';
import { BulkMessageSendJobData } from '../bulkMessageSend.queue';
import MessageService from '@surefy/console/services/message.service';
import PhoneNumberModel from '@surefy/console/models/phoneNumber.model';
import CompanyModel from '@surefy/console/models/company.model';
import userModel from '@surefy/console/app/models/user.model';

const BATCH_SIZE = 50; // Process 50 messages at a time
const DELAY_BETWEEN_BATCHES = 1000; // 1 second delay between batches
const MAX_PARALLEL_SENDS = Number(process.env.BULK_MESSAGE_CONCURRENCY ?? 2);
if (!Number.isInteger(MAX_PARALLEL_SENDS) || MAX_PARALLEL_SENDS < 1 || MAX_PARALLEL_SENDS > 10) {
  throw new Error('BULK_MESSAGE_CONCURRENCY must be an integer from 1 to 10');
}

async function processBulkMessageSend(job: Job<BulkMessageSendJobData>, token?: string) {
  job.discard(); // Also protect jobs queued before the no-replay policy.
  const { userId, messages } = job.data;
  const nextIndex = job.data.nextIndex ?? 0;
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 0 || nextIndex > messages.length) throw new Error('Invalid bulk-send checkpoint');
  const yieldForShutdown = async () => {
    await job.moveToDelayed(Date.now() + 1000, token);
    throw new DelayedError();
  };

  console.log(`Starting bulk message send for company ${userId}, total messages: ${messages.length}`);
  let sendsStarted = false;

  try {
    // Verify company exists and has sufficient credits
    const user = await userModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const results = job.data.result || {
      total: messages.length,
      successful: 0,
      failed: 0,
      errors: [] as any[],
    };

    // Process messages in batches
    for (let i = nextIndex; i < messages.length; i += BATCH_SIZE) {
      if (isWorkerDraining()) return await yieldForShutdown();
      const batch = messages.slice(i, i + BATCH_SIZE);

      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}, messages ${i + 1} to ${Math.min(i + BATCH_SIZE, messages.length)}`);

      // Bound active sends so bulk jobs do not exhaust the pool used by campaigns.
      const batchResults: PromiseSettledResult<{ success: boolean; to: string; message?: any; error?: string }>[] = [];
      for (let offset = 0; offset < batch.length; offset += MAX_PARALLEL_SENDS) {
        const chunk = batch.slice(offset, offset + MAX_PARALLEL_SENDS);
        batchResults.push(...await Promise.allSettled(
          chunk.map(async (messageData) => {
          try {
            sendsStarted = true;
            const message = await MessageService.sendMessage({
              user_id: userId,
              company_id: messageData.company_id,
              country_code: messageData.country_code,
              campaign_id: null,
              phone_number_id: messageData.phone_number_id,
              to: messageData.to,
              type: messageData.type,
              text: messageData.text,
              template: messageData.template,
              image: messageData.image,
              video: messageData.video,
              document: messageData.document,
              audio: messageData.audio,
              context: messageData.context,
            });

            return { success: true, to: messageData.to, message };
          } catch (error: any) {
            if (getDatabaseFailure(error)) throw error;
            console.error(`Failed to send message to ${messageData.to}:`, error.message);
            return {
              success: false,
              to: messageData.to,
              error: error.message,
            };
          }
          })
        ));
        const infrastructureFailure = batchResults.find(result => result.status === 'rejected' && getDatabaseFailure(result.reason));
        if (infrastructureFailure?.status === 'rejected') throw infrastructureFailure.reason;
      }

      // Count results
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.success) {
          results.successful++;
        } else {
          results.failed++;
          if (result.status === 'fulfilled') {
            results.errors.push({
              to: result.value.to,
              error: result.value.error,
            });
          } else {
            results.errors.push({
              error: result.reason?.message || 'Unknown error',
            });
          }
        }
      });

      // Persist completed recipients before yielding; only untouched recipients resume.
      results.errors = results.errors.slice(0, 100);
      await job.updateData({ ...job.data, nextIndex: i + batch.length, result: results });
      // Update progress
      const progress = Math.round(((i + batch.length) / messages.length) * 100);
      await job.updateProgress(progress);

      console.log(`Batch completed: ${results.successful} successful, ${results.failed} failed. Progress: ${progress}%`);

      // Delay between batches to avoid rate limiting (except for the last batch)
      if (i + BATCH_SIZE < messages.length) {
        if (isWorkerDraining()) return await yieldForShutdown();
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    console.log(`Bulk message send completed for company ${userId}. Total: ${results.total}, Successful: ${results.successful}, Failed: ${results.failed}`);

    return results;
  } catch (error: any) {
    if (error instanceof DelayedError) throw error;
    // A batch may already contain accepted sends. Never replay it automatically.
    if (sendsStarted && getDatabaseFailure(error)) job.discard();
    reportBackgroundError('Worker bulk-message-send', error, { userId });
    throw error;
  }
}

// Create and start the worker
console.log('📦 Initializing Bulk Message Send Worker...');

export const bulkMessageSendWorker = createDatabaseAwareWorker<BulkMessageSendJobData>(
  'bulk-message-send',
  async (job, token) => {
    console.log(`🔄 Processing bulk message send job ${job.id}...`);
    return await processBulkMessageSend(job, token);
  },
  {
    connection: redisConfig,
    concurrency: 1, // Keep bulk sends from starving campaign jobs sharing this DB pool
    maxStalledCount: 0,
    limiter: {
      max: 10, // Max 10 jobs
      duration: 1000, // per second
    },
  }
);

bulkMessageSendWorker.on('completed', (job, result) => {
  console.log(`✅ Bulk message send job ${job.id} completed: ${result.successful} successful, ${result.failed} failed`);
});

bulkMessageSendWorker.on('failed', (job, err) => {
  reportBackgroundError('Worker bulk-message-send', err, { jobId: job?.id });
});

bulkMessageSendWorker.on('error', (error) => {
  reportBackgroundError('Worker bulk-message-send', error);
});

bulkMessageSendWorker.on('ready', () => {
  console.log('✅ Bulk Message Send Worker is ready and listening for jobs');
});

bulkMessageSendWorker.on('active', (job) => {
  console.log(`🔄 Bulk message send job ${job.id} is now active`);
});

console.log('🚀 Bulk Message Send Worker started and waiting for jobs...');
