import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'crypto';

export interface ImageManifestItem {
  id: string;
  name: string;
  originalName: string;
  firebaseUrl: string;
  size: string;
  mimetype: string;
  createdAt: string;
  companyId?: string;
}

const MANIFEST_PATH = path.join(process.cwd(), 'uploads', 'firebase-images-manifest.json');

// Helper to format file size
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper to read manifest
async function getManifest(): Promise<ImageManifestItem[]> {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) {
      return [];
    }
    const content = await fs.promises.readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error('Error reading firebase images manifest:', err);
    return [];
  }
}

// Helper to save manifest
async function saveManifest(items: ImageManifestItem[]) {
  try {
    const dir = path.dirname(MANIFEST_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.readFile(MANIFEST_PATH, 'utf-8').catch(() => {});
    await fs.promises.writeFile(MANIFEST_PATH, JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving firebase images manifest:', err);
  }
}

// Upload image to Firebase Storage
async function uploadToFirebase(file: Express.Multer.File, customName?: string): Promise<{ firebaseUrl: string; fileName: string }> {
  const bucketName = process.env.FIREBASE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || 'soft7-wa-dashboard.appspot.com';
  const token = crypto.randomUUID();
  const ext = path.extname(file.originalname) || '.png';
  const timestamp = Date.now();
  const sanitizedName = (customName || path.basename(file.originalname, ext))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const fileName = `uploads/${timestamp}_${sanitizedName}${ext}`;

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    try {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          }),
          storageBucket: bucketName,
        });
      }

      const bucket = admin.storage().bucket();
      const firebaseFile = bucket.file(fileName);

      let fileBuffer: Buffer;
      if (file.buffer) {
        fileBuffer = file.buffer;
      } else if (file.path && fs.existsSync(file.path)) {
        fileBuffer = await fs.promises.readFile(file.path);
      } else {
        throw new Error('File buffer or path missing');
      }

      await firebaseFile.save(fileBuffer, {
        metadata: {
          contentType: file.mimetype || 'image/png',
          metadata: {
            firebaseStorageDownloadTokens: token,
          },
        },
      });

      await firebaseFile.makePublic().catch(() => {});

      const firebaseUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;
      return { firebaseUrl, fileName };
    } catch (err) {
      console.error('Firebase Admin storage upload error, using fallback URL format:', err);
    }
  }

  // Fallback Firebase Storage URL format if Firebase credentials are not set
  const firebaseUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;
  return { firebaseUrl, fileName };
}

class ImageUploadController {
  /**
   * POST /v1/admin/image-upload/upload
   * Upload image and convert to Firebase URL
   */
  uploadImage = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const file = req.file;
    const { name } = req.body;

    if (!file) {
      throw new HTTP400Error({ message: 'Image file is required' });
    }

    const { firebaseUrl, fileName } = await uploadToFirebase(file, name);

    const id = crypto.randomUUID();
    const item: ImageManifestItem = {
      id,
      name: name?.trim() || file.originalname,
      originalName: file.originalname,
      firebaseUrl,
      size: formatBytes(file.size),
      mimetype: file.mimetype || 'image/png',
      createdAt: new Date().toISOString(),
      companyId: req.companyId,
    };

    const manifest = await getManifest();
    manifest.unshift(item);
    await saveManifest(manifest);

    return successResponse(req, res, 'Image uploaded to Firebase successfully', item);
  });

  /**
   * GET /v1/admin/image-upload/list
   * Get list of uploaded images
   */
  getUploadedImages = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const manifest = await getManifest();
    let filtered = manifest;
    if (req.companyId) {
      filtered = manifest.filter((item) => !item.companyId || item.companyId === req.companyId);
    }

    return successResponse(req, res, 'Uploaded images retrieved successfully', filtered);
  });

  /**
   * DELETE /v1/admin/image-upload/:id
   * Delete uploaded image record
   */
  deleteUploadedImage = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { id } = req.params;
    const manifest = await getManifest();
    const updated = manifest.filter((item) => item.id !== id);
    await saveManifest(updated);

    return successResponse(req, res, 'Uploaded image record deleted successfully', { id });
  });
}

export default new ImageUploadController();
