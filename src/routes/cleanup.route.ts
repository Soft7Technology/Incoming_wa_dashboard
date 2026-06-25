import { Router } from 'express';
import cleanupController from '../app/http/controllers/cleanup.controller';

const cleanupRoute = Router();

cleanupRoute.post('/', cleanupController.cleanupData);

export default cleanupRoute;
