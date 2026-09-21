// Compatibility adapter for shared authentication middleware.
// API-key business logic lives in the application service; SQL lives in its model.
import UserApiKeyService from '@surefy/console/services/userApiKey.service';
export { hashApiKey } from '@surefy/console/services/userApiKey.service';

export const issueUserApiKey = (userId: string, companyId: string) =>
  UserApiKeyService.createKey({ userId, companyId });

export const authenticateUserApiKey = (key: string) => UserApiKeyService.authenticate(key);
