import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { FacebookError } from './facebook';

export const publishingMediaRoot = () =>
  path.resolve(process.env.INSTAGRAM_PUBLISH_UPLOAD_DIR || 'uploads/.instagram-publishing');
export const publishingMediaPath = (filename: string) => {
  if (!/^[0-9a-f-]{36}\.(jpg|mp4)$/.test(filename)) throw new FacebookError(404, 'Media not found.');
  return path.join(publishingMediaRoot(), filename);
};
export const receivePublishingMedia = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => {
      fs.mkdirSync(publishingMediaRoot(), { recursive: true });
      done(null, publishingMediaRoot());
    },
    filename: (_req, file, done) =>
      done(null, crypto.randomUUID() + (file.mimetype === 'image/jpeg' ? '.jpg' : '.mp4')),
  }),
  fileFilter: (_req, file, done) => {
    if (!['image/jpeg', 'video/mp4'].includes(file.mimetype))
      return done(new FacebookError(400, 'Choose a JPEG photo or MP4 Reel.'));
    done(null, true);
  },
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 1 },
}).single('file');

export async function validatePublishingMedia(file: Express.Multer.File) {
  const location = publishingMediaPath(file.filename);
  if (path.resolve(file.path) !== location) throw new FacebookError(400, 'Invalid upload location.');
  const handle = await fs.promises.open(location, 'r');
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const image = file.mimetype === 'image/jpeg';
  if (
    image
      ? !(header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
      : header.toString('ascii', 4, 8) !== 'ftyp'
  )
    throw new FacebookError(400, 'The file contents must be a JPEG image or MP4 video.');
  if (image && file.size > 8 * 1024 * 1024) throw new FacebookError(413, 'JPEG photos must be 8 MB or smaller.');
  return image ? 'IMAGE' : 'REELS';
}

export async function removePublishingMedia(filename: string) {
  await fs.promises.unlink(publishingMediaPath(filename)).catch(() => {});
}

// Also removes orphan files left after account deletion. Capability URLs expire
// after 24 hours; expired files are removed during subsequent upload activity.
export async function cleanPublishingMedia() {
  const entries = await fs.promises.readdir(publishingMediaRoot()).catch(() => []);
  for (const filename of entries) {
    if (!/^[0-9a-f-]{36}\.(jpg|mp4)$/.test(filename)) continue;
    const stat = await fs.promises.stat(publishingMediaPath(filename)).catch(() => null);
    if (stat?.isFile() && stat.mtimeMs < Date.now() - 48 * 3600000) await removePublishingMedia(filename);
  }
}
