import { Router } from 'express';
import UserApiKeyController from '@surefy/console/http/controllers/userApiKey.controller';

const UserApiKeyRoute = Router();

// User JWT authentication is applied by AdminRoute.
UserApiKeyRoute.post('/', UserApiKeyController.createKey);
UserApiKeyRoute.get('/', UserApiKeyController.getKeys);
UserApiKeyRoute.delete('/:id', UserApiKeyController.revokeKey);

export default UserApiKeyRoute;
