import { Queue } from 'bullmq';
import { reportBackgroundError } from '@surefy/utils/databaseErrors';
import redisConfig from '@surefy/config/redis.config';
import Redis from 'ioredis';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';

export interface ContactImportJobData {
  jobId: string; // Import job ID from database
  userId:string,
  companyId:string;
  phone_number_id:any;
  country_code:any;
  filePath: string;
  listName: string;
  options: {
    phoneColumn?: string;
    nameColumn?: string;
    emailColumn?: string;
    tagIds?: string[];
  };
}

const producer = new Redis({ ...redisConfig, maxRetriesPerRequest: 1,
  enableOfflineQueue: false, autoResendUnfulfilledCommands: false, connectTimeout: 5000, commandTimeout: 5000 });
producer.on('error', error => reportBackgroundError('Queue contact-import', error));
export const contactImportQueue = new Queue<ContactImportJobData>('contact-import', {
  connection: producer,
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
  reportBackgroundError('Queue contact-import', error);
});

export async function ensureContactImportQueueReady(waitForInitialConnection = true): Promise<void> {
  if (producer.status === 'ready') return;
  const unavailable = () => new CustomError('Contact import processing is temporarily unavailable. Please try again shortly.', HttpStatusCode.SERVICE_UNAVAILABLE);
  // The queue is lazily imported by the API: allow its first connection to establish.
  // Status polls and established outages must not wait for reconnection.
  if (!waitForInitialConnection || !['connecting', 'connect', 'wait'].includes(producer.status)) throw unavailable();
  await new Promise<void>((resolve, reject) => {
    const clean = () => { clearTimeout(timer); producer.removeListener('ready', ready); producer.removeListener('error', fail); producer.removeListener('end', fail); };
    const ready = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(unavailable()); };
    const timer = setTimeout(fail, 5000);
    producer.once('ready', ready); producer.once('error', fail); producer.once('end', fail);
    if (producer.status === 'ready') ready();
  });
}

export async function getContactImportQueueStatus(jobId: string) {
  await ensureContactImportQueueReady(false);
  const job = await contactImportQueue.getJob(jobId);
  return job ? { state: await job.getState(), attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 } : null;
}

export async function closeContactImportQueue(): Promise<void> {
  try { await contactImportQueue.close(); }
  finally { producer.disconnect(); }
}
