import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import { reportBackgroundError } from '@surefy/utils/databaseErrors';
import { mediaUploadLimit, mediaUploadLimitMessage } from '@surefy/utils/mediaUploadLimits';
import MediaGalleryModel from '../models/mediaGallery.model';
import { mediaUploadQueue, ensureMediaQueueReady } from '../../queues/mediaUpload.queue';
import { MEDIA_BACKGROUND_THRESHOLD, MEDIA_UPLOAD_ROOT, MEDIA_MAX_FILE_SIZE, MediaUploadData,
  formatMediaBytes, galleryBucket, stagedMediaPath, removeStagedMedia, streamGalleryMedia, MediaProgressCallback } from '../utils/mediaUpload';

async function cleanup(data: MediaUploadData): Promise<void> {
  try { await removeStagedMedia(data); }
  catch (error) { reportBackgroundError('Media upload cleanup', error, { uploadId: data.uploadId }); }
}

export async function processGalleryUpload(data: MediaUploadData, onProgress?: MediaProgressCallback) {
  // The stable ID/object name/token make retries safe after Firebase or DB acknowledgement loss.
  const existing = await MediaGalleryModel.findByIdAndUserId(data.uploadId, data.userId);
  if (existing) { await cleanup(data); onProgress?.('completed', data.size); return existing; }
  const { firebaseUrl, fileName } = await streamGalleryMedia(data, onProgress);
  onProgress?.('saving', data.size);
  const item = await MediaGalleryModel.createForUpload({
    id: data.uploadId, user_id: data.userId, name: data.name, original_name: data.originalName,
    firebase_url: firebaseUrl, firebase_file_name: fileName, size: formatMediaBytes(data.size), mimetype: data.mimetype,
  });
  await cleanup(data);
  onProgress?.('completed', data.size);
  return item;
}

export async function startGalleryUpload(userId: string, file: Express.Multer.File, customName?: unknown) {
  if (!file.path) throw new HTTP400Error({ message: 'A media file is required' });
  // Only files written by the existing upload middleware may be moved to the worker spool.
  if (path.dirname(path.resolve(file.path)) !== path.resolve(process.cwd(), 'uploads')) {
    throw new HTTP400Error({ message: 'Invalid uploaded file location' });
  }
  let data: MediaUploadData | undefined;
  let enqueueAttempted = false;
  try {
    if (file.size > mediaUploadLimit(file.mimetype)) {
      throw new CustomError(mediaUploadLimitMessage(file.mimetype), HttpStatusCode.PAYLOAD_TOO_LARGE);
    }
    if (customName !== undefined && (typeof customName !== 'string' || customName.trim().length > 255)) {
      throw new HTTP400Error({ message: 'Media name must be a string with at most 255 characters' });
    }
    if (file.originalname.length > 255 || file.size <= 0 || file.size > MEDIA_MAX_FILE_SIZE) {
      throw new HTTP400Error({ message: 'Media must be a non-empty file up to 50 MB with a filename up to 255 characters' });
    }
    galleryBucket(); // Fail before queueing when storage configuration is missing.
    const background = file.size > MEDIA_BACKGROUND_THRESHOLD;
    if (background) ensureMediaQueueReady();
    const uploadId = randomUUID();
    const candidateExt = path.extname(file.originalname).toLowerCase();
    const ext = /^\.[a-z0-9]+$/.test(candidateExt) ? candidateExt : '.bin';
    data = { uploadId, userId, name: (customName as string | undefined)?.trim() || file.originalname,
      originalName: file.originalname, mimetype: file.mimetype, size: file.size,
      stagedName: `${uploadId}${ext}`, downloadToken: randomUUID() };
    await fs.promises.mkdir(MEDIA_UPLOAD_ROOT, { recursive: true });
    await fs.promises.rename(file.path, stagedMediaPath(data));
    if (!background) return { queued: false as const, item: await processGalleryUpload(data) };
    enqueueAttempted = true;
    try { await mediaUploadQueue.add('gallery-upload', data, { jobId: uploadId }); }
    catch (error) {
      reportBackgroundError('Media upload enqueue', error, { uploadId });
      throw new CustomError('Media upload could not be queued. Please try again shortly.', HttpStatusCode.SERVICE_UNAVAILABLE,
        true, { job_id: uploadId, status_url: `/v1/admin/image-upload/jobs/${uploadId}` });
    }
    return { queued: true as const, job: { job_id: uploadId, status: 'queued', execution_mode: 'worker',
      status_url: `/v1/admin/image-upload/jobs/${uploadId}`, poll_after_ms: 2000 } };
  } catch (error) {
    // If Redis accepted a job but its acknowledgement was lost, the worker still needs its file.
    if (!enqueueAttempted) {
      if (data) await cleanup(data);
      await fs.promises.unlink(file.path).catch(() => {});
    }
    throw error;
  }
}

export async function getGalleryUploadStatus(userId: string, uploadId: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(uploadId)) throw new HTTP404Error({ message: 'Upload job not found' });
  // Completed gallery records remain available even after Redis's job retention expires.
  const item = await MediaGalleryModel.findByIdAndUserId(uploadId, userId);
  if (item) return { job_id: uploadId, status: 'completed', stage: 'completed', progress: 100,
    estimated_remaining_seconds: 0, elapsed_seconds: null, processing_elapsed_seconds: null, result: item };
  ensureMediaQueueReady();
  const job = await mediaUploadQueue.getJob(uploadId);
  if (!job || job.data.userId !== userId) throw new HTTP404Error({ message: 'Upload job not found' });
  const state = await job.getState();
  const now = Date.now();
  const finished = state === 'completed' || state === 'failed';
  const end = finished ? job.finishedOn : now;
  const secondsSince = (start?: number) => start && end ? Math.max(0, Math.floor((end - start) / 1000)) : null;
  const snapshot = typeof job.progress === 'object' && job.progress ? job.progress as Record<string, any> : {};
  const active = state === 'active';
  const stage = finished ? state : active ? (['uploading', 'saving', 'completed'].includes(snapshot.stage) ? snapshot.stage : 'preparing') : 'queued';
  const bytes = active || finished ? Math.max(0, Math.min(job.data.size, Number(snapshot.bytes_transferred) || 0)) : 0;
  const duration = now - Number(snapshot.upload_started_at);
  const fresh = Number(snapshot.updated_at) <= now && now - Number(snapshot.updated_at) < 10000;
  // This estimates only the remaining transfer, excluding queue wait, storage finalization and the DB write.
  const remaining = active && stage === 'uploading' && fresh && duration >= 1000 && bytes > 0 && bytes < job.data.size
    ? Math.ceil((job.data.size - bytes) / (bytes / (duration / 1000))) : null;
  const details = {
    job_id: uploadId, stage, progress: state === 'completed' ? 100 : Math.min(99, Math.floor(bytes / job.data.size * 100)),
    bytes_transferred: bytes, total_bytes: job.data.size,
    elapsed_seconds: secondsSince(job.timestamp), processing_elapsed_seconds: secondsSince(job.processedOn),
    estimated_remaining_seconds: state === 'completed' ? 0 : remaining,
    attempts_made: job.attemptsMade, max_attempts: job.opts.attempts ?? 1,
  };
  if (state === 'failed') return { ...details, status: 'failed', error: 'Media upload failed. Please retry the upload or contact support.' };
  if (state === 'completed') return { ...details, status: 'completed', result: job.returnvalue };
  return { ...details, status: active ? 'processing' : 'queued', poll_after_ms: 2000 };
}
