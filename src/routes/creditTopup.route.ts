import { Router } from 'express';
import { requireRole } from '@surefy/middleware/jwtAuth.middleware';
import controller from '../app/http/controllers/creditTopup.controller';

const route = Router();
// JWT authentication is inherited from /v1/admin; never accept client-supplied company IDs.
route.use(requireRole('admin', 'company'), controller.noStore);
route.get('/options', controller.options);
route.post('/', controller.create);
route.get('/', controller.list);
route.get('/:id', controller.get);
route.post('/:id/verify', controller.verify);
export default route;
