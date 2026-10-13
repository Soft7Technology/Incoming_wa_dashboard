import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as admin from 'firebase-admin';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import { MAX_MEDIA_UPLOAD_BYTES, mediaUploadLimit, mediaUploadLimitMessage } from '@surefy/utils/mediaUploadLimits';

export const MEDIA_BACKGROUND_THRESHOLD = 3 * 1024 * 1024;
export const MEDIA_MAX_FILE_SIZE = MAX_MEDIA_UPLOAD_BYTES;
// Express's existing /uploads static route ignores dot directories, keeping staged files private.
export const MEDIA_UPLOAD_ROOT = path.join(process.cwd(), 'uploads', '.media-upload');

export interface MediaUploadData {
  uploadId: string;
  userId: string;
  name: string;
  originalName: string;
  mimetype: string;
  size: number;
  stagedName: string;
  downloadToken: string;
}

export type MediaProgressCallback = (stage: 'uploading' | 'saving' | 'completed', bytesTransferred: number) => void;

export function formatMediaBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const unit = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / 1024 ** unit).toFixed(2))} ${['Bytes', 'KB', 'MB', 'GB'][unit]}`;
}

export function stagedMediaPath(data: MediaUploadData): string {
  if (!/^[a-f0-9-]{36}\.[a-z0-9]+$/i.test(data.stagedName) || !data.stagedName.startsWith(`${data.uploadId}.`)) {
    throw new Error('Invalid staged media file');
  }
  return path.join(MEDIA_UPLOAD_ROOT, data.stagedName);
}

export async function removeStagedMedia(data: MediaUploadData): Promise<void> {
  await fs.promises.unlink(stagedMediaPath(data)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export function galleryBucket() {
  const bucketName = process.env.FIREBASE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || 'soft7-wa-dashboard.appspot.com';
  if (!admin.apps.length) {
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
      throw new CustomError('Media storage is not configured. Please contact support.', HttpStatusCode.SERVICE_UNAVAILABLE);
    }
    admin.initializeApp({ credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }), storageBucket: bucketName });
  }
  return admin.storage().bucket(bucketName);
}

export async function streamGalleryMedia(data: MediaUploadData, onProgress?: MediaProgressCallback): Promise<{ firebaseUrl: string; fileName: string }> {
  const filePath = stagedMediaPath(data);
  let realPath: string;
  try { realPath = await fs.promises.realpath(filePath); }
  catch (error: any) {
    if (error.code === 'ENOENT') throw new Error('Uploaded file is unavailable to the worker. Check shared upload storage.');
    throw error;
  }
  const realRoot = await fs.promises.realpath(MEDIA_UPLOAD_ROOT);
  if (path.dirname(realPath) !== realRoot) throw new Error('Invalid staged media location');
  const stat = await fs.promises.stat(realPath);
  if (stat.size > mediaUploadLimit(data.mimetype)) throw new CustomError(mediaUploadLimitMessage(data.mimetype), HttpStatusCode.PAYLOAD_TOO_LARGE);
  if (!stat.isFile() || stat.size !== data.size || stat.size > MEDIA_MAX_FILE_SIZE) throw new Error('Staged media size does not match the upload');
  const bucket = galleryBucket();
  const fileName = `uploads/${data.userId}/${data.stagedName}`;
  try {
    const destination = bucket.file(fileName).createWriteStream({
      resumable: data.size > MEDIA_BACKGROUND_THRESHOLD,
      chunkSize: 1024 * 1024,
      timeout: 120000,
      metadata: { contentType: data.mimetype, metadata: { firebaseStorageDownloadTokens: data.downloadToken } },
    });
    if (onProgress) destination.on('progress', (event: { bytesWritten: number }) => {
      if (Number.isFinite(event.bytesWritten)) onProgress('uploading', Math.min(data.size, Math.max(0, event.bytesWritten)));
    });
    await pipeline(fs.createReadStream(realPath), destination, { signal: AbortSignal.timeout(120000) });
  } catch (cause) {
    const error = new CustomError('Media storage upload failed. Please retry the upload.', HttpStatusCode.SERVICE_UNAVAILABLE);
    (error as any).cause = cause;
    throw error;
  }
  return {
    fileName,
    firebaseUrl: `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media&token=${data.downloadToken}`,
  };
}
