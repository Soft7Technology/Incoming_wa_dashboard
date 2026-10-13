import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { Request, Response, NextFunction } from 'express';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import { MAX_MEDIA_UPLOAD_BYTES, mediaUploadLimit, mediaUploadLimitMessage } from '@surefy/utils/mediaUploadLimits';

const receivedMediaTypes = new WeakMap<Request, string>();

// Configure storage for file uploads
const storage = multer.diskStorage({
  destination: (req: Request, file: any, cb: any) => {
    const uploadDir = path.join(process.cwd(), 'uploads');

    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    cb(null, uploadDir);
  },
  filename: (req: Request, file: Express.Multer.File, cb: any) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

// File filter for XLSX files
const xlsx_csvFileFilter = (req: Request, file: any, cb: any) => {
  const allowedMimes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls

    // CSV
    'text/csv',
    'application/csv',
    'text/plain',
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new HTTP400Error({ message: 'Only Excel files (.xlsx, .xls) are allowed' }));
  }
};

// File filter for media files (images, videos, documents)
const mediaFileFilter = (req: Request, file: any, cb: any) => {
  const allowedMimes = [
    // Images
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    // Videos
    'video/mp4',
    'video/3gpp',
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    // Audio
    'audio/mpeg',
    'audio/ogg',
    'audio/aac',
  ];

  if (allowedMimes.includes(file.mimetype)) {
    receivedMediaTypes.set(req, file.mimetype);
    cb(null, true);
  } else {
    cb(new HTTP400Error({ message: 'Invalid file type. Allowed: images (jpg, png, webp), videos (mp4, 3gp), documents (pdf, doc, docx), audio (mp3, ogg, aac)' }));
  }
};

// Multer configurations
const uploadXLSX = multer({
  storage,
  fileFilter: xlsx_csvFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for XLSX
  },
});

const uploadMedia = multer({
  storage,
  fileFilter: mediaFileFilter,
  limits: {
    fileSize: MAX_MEDIA_UPLOAD_BYTES, // Images receive the smaller limit below.
  },
});

console.log("Media File", uploadMedia)

const ROOT_DIR = process.cwd();
console.log("Root DIR",ROOT_DIR)

export const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');

// Export middleware
export const uploadXLSXMiddleware = uploadXLSX.single('file');
const receiveMedia = uploadMedia.single('file');
export const uploadMediaMiddleware = (req: Request, res: Response, next: NextFunction) => {
  receiveMedia(req, res, error => {
    const mimetype = receivedMediaTypes.get(req) || req.file?.mimetype || '';
    receivedMediaTypes.delete(req);
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return next(new CustomError(mediaUploadLimitMessage(mimetype), HttpStatusCode.PAYLOAD_TOO_LARGE));
    }
    if (error) return next(error);
    if (req.file && req.file.size > mediaUploadLimit(mimetype)) {
      const failure = new CustomError(mediaUploadLimitMessage(mimetype), HttpStatusCode.PAYLOAD_TOO_LARGE);
      return fs.unlink(req.file.path, cleanupError => {
        if (cleanupError && cleanupError.code !== 'ENOENT') console.warn('Media upload cleanup failed', { code: cleanupError.code });
        delete req.file;
        next(failure);
      });
    }
    next(error);
  });
};
