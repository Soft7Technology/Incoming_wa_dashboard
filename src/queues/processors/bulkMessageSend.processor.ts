import { Worker, Job } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';
import { BulkMessageSendJobData } from '../bulkMessageSend.queue';
import MessageService from '@surefy/console/services/message.service';
import PhoneNumberModel from '@surefy/console/models/phoneNumber.model';
import CompanyModel from '@surefy/console/models/company.model';
import userModel from '@surefy/console/app/models/user.model';

const BATCH_SIZE = 50; // Process 50 messages at a time
const DELAY_BETWEEN_BATCHES = 1000; // 1 second delay between batches

async function processBulkMessageSend(job: Job<BulkMessageSendJobData>) {
  const { userId, messages } = job.data;

  console.log(`Starting bulk message send for company ${userId}, total messages: ${messages.length}`);

  try {
    // Verify company exists and has sufficient credits
    const user = await userModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const results = {
      total: messages.length,
      successful: 0,
      failed: 0,
      errors: [] as any[],
    };

    // Process messages in batches
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);

      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}, messages ${i + 1} to ${Math.min(i + BATCH_SIZE, messages.length)}`);

      // Process batch in parallel
      const batchResults = await Promise.allSettled(
        batch.map(async (messageData) => {
          try {
            const message = await MessageService.sendMessage({
              user_id: userId,
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
            console.error(`Failed to send message to ${messageData.to}:`, error.message);
            return {
              success: false,
              to: messageData.to,
              error: error.message,
            };
          }
        })
      );

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

      // Update progress
      const progress = Math.round(((i + batch.length) / messages.length) * 100);
      await job.updateProgress(progress);

      console.log(`Batch completed: ${results.successful} successful, ${results.failed} failed. Progress: ${progress}%`);

      // Delay between batches to avoid rate limiting (except for the last batch)
      if (i + BATCH_SIZE < messages.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    console.log(`Bulk message send completed for company ${userId}. Total: ${results.total}, Successful: ${results.successful}, Failed: ${results.failed}`);

    return results;
  } catch (error: any) {
    console.error(`Bulk message send failed for company ${userId}:`, error);
    throw error;
  }
}

// Create and start the worker
console.log('📦 Initializing Bulk Message Send Worker...');

export const bulkMessageSendWorker = new Worker<BulkMessageSendJobData>(
  'bulk-message-send',
  async (job) => {
    console.log(`🔄 Processing bulk message send job ${job.id}...`);
    return await processBulkMessageSend(job);
  },
  {
    connection: redisConfig,
    concurrency: 2, // Process 2 bulk jobs at a time
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
  console.error(`❌ Bulk message send job ${job?.id} failed:`, err.message);
  console.error('Stack:', err.stack);
});

bulkMessageSendWorker.on('error', (error) => {
  console.error('❌ Bulk Message Send Worker Error:', error);
});

bulkMessageSendWorker.on('ready', () => {
  console.log('✅ Bulk Message Send Worker is ready and listening for jobs');
});

bulkMessageSendWorker.on('active', (job) => {
  console.log(`🔄 Bulk message send job ${job.id} is now active`);
});

console.log('🚀 Bulk Message Send Worker started and waiting for jobs...');
