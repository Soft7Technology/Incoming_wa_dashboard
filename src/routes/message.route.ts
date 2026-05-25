import { Router } from 'express';
import MessageController from '@surefy/console/http/controllers/message.controller';
import { checkPlanLimit } from '@surefy/middleware/plan.middleware';

const MessageRoute = Router();

// Message operations - require authentication (applied at route group level)
MessageRoute.post('/send', MessageController.sendMessage);
MessageRoute.post('/bulk-send', MessageController.bulkSendMessages);
MessageRoute.post('/mark-read', MessageController.markAsRead);
MessageRoute.get('/', MessageController.getMessages);
MessageRoute.get('/conversations', MessageController.getMessagesConversations)
MessageRoute.get('/lead/conversations', MessageController.getLeadConversations);

export default MessageRoute;
