import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { Request } from 'express';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

// Configure storage for file uploads
const storage = multer.diskStorage({
  destination: (req: Request, file: any, cb: any) => {
    const uploadDir = path.join(process.cwd(), 'uploads', 'temp');

    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    cb(null, uploadDir);
  },
  filename: (req: Request, file: any, cb: any) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

// File filter for XLSX files
const xlsxFileFilter = (req: Request, file: any, cb: any) => {
  const allowedMimes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
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
    cb(null, true);
  } else {
    cb(new HTTP400Error({ message: 'Invalid file type. Allowed: images (jpg, png, webp), videos (mp4, 3gp), documents (pdf, doc, docx), audio (mp3, ogg, aac)' }));
  }
};

// Multer configurations
const uploadXLSX = multer({
  storage,
  fileFilter: xlsxFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for XLSX
  },
});

const uploadMedia = multer({
  storage,
  fileFilter: mediaFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for media files
  },
});

// Export middleware
export const uploadXLSXMiddleware = uploadXLSX.single('file');
export const uploadMediaMiddleware = uploadMedia.single('file');
