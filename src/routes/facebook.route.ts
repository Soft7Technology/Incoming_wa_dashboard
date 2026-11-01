import { Router, Response } from 'express';
import { jwtAuthMiddleware, requireRole } from '@surefy/middleware/jwtAuth.middleware';
import AuthController from '@surefy/console/http/controllers/auth.controller';
import teamController from '../app/http/controllers/team.controller';
import { uploadMediaMiddleware } from '@surefy/middleware/upload.middleware';
import { authorizeSocketOrigin } from '../app/services/socketSession.service';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync } from '@surefy/utils/Controller';
import facebookOAuthController from '../app/http/controllers/facebookOAuth.controller';
import facebookPageController from '../app/http/controllers/facebookPage.controller';
import facebookLeadController from '../app/http/controllers/facebookLead.controller';
import facebookMessagingController from '../app/http/controllers/facebookMessaging.controller';

const facebookRoute = Router()


facebookRoute.get('/setup',facebookOAuthController.setup)
facebookRoute.post('/oauth/start',facebookOAuthController.start)
facebookRoute.get('/oauth/pages',facebookOAuthController.pages)

facebookRoute.get('/pages',facebookPageController.list)
facebookRoute.post('/pages',facebookPageController.connect)
facebookRoute.delete('/pages/:pageConnectionId',facebookPageController.disconnect)

facebookRoute.get('/pages/:pageConnectionId/conversations', facebookMessagingController.listConversations)
facebookRoute.get('/conversations/:conversationId/messages', facebookMessagingController.listMessages)
facebookRoute.post('/conversations/:conversationId/messages', facebookMessagingController.sendMessage)

facebookRoute.post('/pages/:pageConnectionId/forms/refresh',facebookLeadController.refreshForms)
facebookRoute.get('/pages/:pageConnectionId/forms',facebookLeadController.listForms)

facebookRoute.patch('/forms/:formConnectionId',facebookLeadController.updateForm)
facebookRoute.post('/forms/:formConnectionId/sync',facebookLeadController.syncForm)
facebookRoute.get('/forms/:formConnectionId/leads',facebookLeadController.listLeads)

export default facebookRoute
