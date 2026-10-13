export const MAX_IMAGE_UPLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_MEDIA_UPLOAD_BYTES = 50 * 1024 * 1024;
export const IMAGE_UPLOAD_LIMIT_MESSAGE = 'Upload Image under 16MB';

export function mediaUploadLimit(mimetype: string): number {
  return mimetype.startsWith('image/') ? MAX_IMAGE_UPLOAD_BYTES : MAX_MEDIA_UPLOAD_BYTES;
}

export function mediaUploadLimitMessage(mimetype: string): string {
  return mimetype.startsWith('image/') ? IMAGE_UPLOAD_LIMIT_MESSAGE : 'Media file must not exceed 50 MB.';
}
