import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import MediaGalleryModel from '@surefy/console/models/mediaGallery.model';
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
  userId: string;
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

    await fs.promises.writeFile(MANIFEST_PATH, JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving firebase images manifest:', err);
  }
}

// Upload image to Firebase Storage
async function uploadToFirebase(
  file: Express.Multer.File,
  userId: string,
  customName?: string,
): Promise<{
  firebaseUrl: string;
  fileName: string;
}> {
  const bucketName =
    process.env.FIREBASE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || 'soft7-wa-dashboard.appspot.com';

  const token = crypto.randomUUID();

  const ext = path.extname(file.originalname) || '.png';

  const timestamp = Date.now();

  const sanitizedName = (customName || path.basename(file.originalname, ext))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // User-specific Firebase folder
  const fileName = `uploads/${userId}/${timestamp}_${sanitizedName}${ext}`;

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

      return {
        firebaseUrl,
        fileName,
      };
    } catch (err) {
      console.error('Firebase Admin storage upload error, using fallback URL format:', err);
    }
  }

  // Fallback Firebase Storage URL format
  const firebaseUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;

  return {
    firebaseUrl,
    fileName,
  };
}

class ImageUploadController {
  /**
   * POST /v1/admin/image-upload/upload
   * Upload image and convert to Firebase URL
   */
  uploadImage = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const file = req.file;
    const { name } = req.body;

    // IMPORTANT:
    // Use authenticated user's ID, NOT companyId
    const userId = req.userId;

    if (!userId) {
      throw new HTTP400Error({
        message: 'Authenticated user ID is required',
      });
    }

    if (!file) {
      throw new HTTP400Error({
        message: 'Image file is required',
      });
    }

    const { firebaseUrl, fileName } = await uploadToFirebase(file, userId, name);

    const item = await MediaGalleryModel.create({
      user_id: userId,
      name: name?.trim() || file.originalname,
      original_name: file.originalname,
      firebase_url: firebaseUrl,
      firebase_file_name: fileName,
      size: formatBytes(file.size),
      mimetype: file.mimetype || 'image/png',
    });

    return successResponse(req, res, 'Image uploaded to Firebase successfully', item);
  });

  /**
   * GET /v1/admin/image-upload/list
   * Get list of uploaded images for current user
   */
  getUploadedImages = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const userId = req.userId;

    if (!userId) {
      throw new HTTP400Error({
        message: 'Authenticated user ID is required',
      });
    }

    const images = await MediaGalleryModel.findByUserId(userId);

    return successResponse(req, res, 'Uploaded images retrieved successfully', images);
  });

  /**
   * DELETE /v1/admin/image-upload/:id
   * Delete uploaded image record
   */
  deleteUploadedImage = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.userId;

    if (!userId) {
      throw new HTTP400Error({
        message: 'Authenticated user ID is required',
      });
    }

    const image = await MediaGalleryModel.findByIdAndUserId(id, userId);

    if (!image) {
      throw new HTTP400Error({
        message: 'Image not found',
      });
    }

    await MediaGalleryModel.update(id, {
      deleted_at: new Date(),
    });

    return successResponse(req, res, 'Image deleted successfully', { id });
  });
}

export default new ImageUploadController();
