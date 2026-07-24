import { Router } from 'express';
import { uploadMediaMiddleware } from '@surefy/middleware/upload.middleware';
import imageUploadController from '@surefy/console/http/controllers/imageUpload.controller';

const imageUploadRoute = Router();

imageUploadRoute.post('/upload', uploadMediaMiddleware, imageUploadController.uploadImage);
imageUploadRoute.get('/list', imageUploadController.getUploadedImages);
imageUploadRoute.delete('/:id', imageUploadController.deleteUploadedImage);

export default imageUploadRoute;
