import { Queue } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';
import { BulkSendMessageDto } from '@surefy/console/interfaces/message.interface';

export interface BulkMessageSendJobData {
  companyId: string;
  messages: BulkSendMessageDto[];
}

export const bulkMessageSendQueue = new Queue<BulkMessageSendJobData>('bulk-message-send', {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // Start with 5 seconds
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 100, // Keep max 100 completed jobs
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

bulkMessageSendQueue.on('error', (error) => {
  console.error('Bulk Message Send Queue Error:', error);
});
