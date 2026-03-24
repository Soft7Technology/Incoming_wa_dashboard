import { Queue } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';

export interface ContactImportJobData {
  jobId: string; // Import job ID from database
  companyId: string;
  userId:string,
  filePath: string;
  listName: string;
  options: {
    phoneColumn?: string;
    nameColumn?: string;
    emailColumn?: string;
    tagIds?: string[];
  };
}

export const contactImportQueue = new Queue<ContactImportJobData>('contact-import', {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
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

contactImportQueue.on('error', (error) => {
  console.error('Contact Import Queue Error:', error);
});