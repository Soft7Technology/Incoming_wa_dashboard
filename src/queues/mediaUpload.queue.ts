import { Queue } from 'bullmq';
import Redis from 'ioredis';
import redisConfig from '@surefy/config/redis.config';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import { reportBackgroundError } from '@surefy/utils/databaseErrors';
import type { MediaUploadData } from '../app/utils/mediaUpload';

// HTTP producers fail promptly instead of holding an upload open through a Redis outage.
const producer = new Redis({ ...redisConfig, maxRetriesPerRequest: 1,
  enableOfflineQueue: false, autoResendUnfulfilledCommands: false, connectTimeout: 5000, commandTimeout: 5000 });
producer.on('error', error => reportBackgroundError('Media upload queue', error));
export const mediaUploadQueue = new Queue<MediaUploadData>('media-upload', {
  connection: producer,
  defaultJobOptions: {
    attempts: 3, backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 7 * 86400, count: 1000 },
  },
});
mediaUploadQueue.on('error', error => reportBackgroundError('Media upload queue', error));

export function ensureMediaQueueReady(): void {
  if (producer.status !== 'ready') {
    throw new CustomError('Media upload processing is temporarily unavailable. Please try again shortly.', HttpStatusCode.SERVICE_UNAVAILABLE);
  }
}

export async function closeMediaUploadQueue(): Promise<void> {
  try { await mediaUploadQueue.close(); }
  finally { producer.disconnect(); }
}
