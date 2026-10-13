import { createDatabaseAwareWorker } from '../databaseAwareWorker';
import redisConfig from '@surefy/config/redis.config';
import { reportBackgroundError } from '@surefy/utils/databaseErrors';
import { processGalleryUpload } from '../../app/services/mediaGalleryUpload.service';
import { MediaUploadData, removeStagedMedia } from '../../app/utils/mediaUpload';

export const mediaUploadWorker = createDatabaseAwareWorker<MediaUploadData>('media-upload', async job => {
  console.info('[Media Upload] Processing in worker', { jobId: job.id, pid: process.pid, bytes: job.data.size });
  const startedAt = Date.now();
  let lastPublishedAt = 0;
  let pending: Record<string, any> | undefined;
  let writing: Promise<void> | undefined;
  // Coalesce byte events and serialize progress writes; progress reporting is best-effort.
  const flush = (): Promise<void> => {
    if (writing) return writing;
    writing = (async () => {
      while (pending) {
        const snapshot = pending; pending = undefined;
        await job.updateProgress(snapshot).catch(error => reportBackgroundError('Media upload progress', error, { jobId: job.id }));
      }
    })().finally(() => { writing = undefined; if (pending) void flush(); });
    return writing;
  };
  const report = (stage: 'uploading' | 'saving' | 'completed', bytes: number) => {
    const now = Date.now();
    if (stage === 'uploading' && lastPublishedAt && now - lastPublishedAt < 1000) return;
    lastPublishedAt = now;
    pending = { stage, bytes_transferred: bytes, total_bytes: job.data.size, upload_started_at: startedAt, updated_at: now };
    void flush();
  };
  try {
    report('uploading', 0);
    const item = await processGalleryUpload(job.data, report);
    while (pending || writing) await flush();
    return item;
  } catch (error) {
    while (pending || writing) await flush();
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      await removeStagedMedia(job.data).catch(cleanupError => reportBackgroundError('Media upload cleanup', cleanupError));
    }
    throw error;
  }
}, { connection: redisConfig, concurrency: 1 });
mediaUploadWorker.on('failed', (job, error) => {
  reportBackgroundError('Worker media-upload', error, { jobId: job?.id });
  // Stalled jobs can fail outside the processor's catch block.
  if (job?.finishedOn) void removeStagedMedia(job.data)
    .catch(cleanupError => reportBackgroundError('Media upload cleanup', cleanupError));
});
mediaUploadWorker.on('error', error => reportBackgroundError('Worker media-upload', error));
