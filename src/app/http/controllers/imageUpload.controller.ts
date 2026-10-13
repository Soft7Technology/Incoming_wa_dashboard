import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import MediaGalleryModel from '@surefy/console/models/mediaGallery.model';
import { startGalleryUpload, getGalleryUploadStatus } from '../../services/mediaGalleryUpload.service';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';

class ImageUploadController {
  /**
   * POST /v1/admin/image-upload/upload
   * Upload small media directly; queue files over 3 MB for the shared worker.
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

    const result = await startGalleryUpload(userId, file, name);
    if (result.queued) {
      res.setHeader('Location', result.job.status_url);
      res.setHeader('Retry-After', '2');
      return successResponse(req, res, 'Media upload queued for processing', result.job, HttpStatusCode.ACCEPTED);
    }
    return successResponse(req, res, 'Image uploaded to Firebase successfully', result.item);

  });

  /**
   * GET /v1/admin/image-upload/jobs/:jobId
   * Get upload state/result for the authenticated user.
   */
  getUploadStatus = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    if (!req.userId) throw new HTTP400Error({ message: 'Authenticated user ID is required' });
    const status = await getGalleryUploadStatus(req.userId, String(req.params.jobId));
    res.setHeader('Cache-Control', 'no-store');
    return successResponse(req, res, 'Media upload status retrieved successfully', status);
  });

  /** GET /v1/admin/image-upload/list */
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
