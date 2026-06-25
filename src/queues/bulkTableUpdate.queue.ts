import { Queue } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';

export interface bulkUpdateTableJobData {
  permission:any
  assigned_to: any;
}

export const bulkUpdateTableExecutionQueue = new Queue<bulkUpdateTableJobData>('bulkUpdateTable-execution', {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 10000, // Start with 10 seconds
    },
    removeOnComplete: {
      age: 48 * 3600, // Keep completed jobs for 48 hours
      count: 200, // Keep max 200 completed jobs
    },
    removeOnFail: {
      age: 14 * 24 * 3600, // Keep failed jobs for 14 days
    },
  },
});

bulkUpdateTableExecutionQueue.on('error', (error) => {
  console.error('Bulk Update Table Execution Queue Error:', error);
});
