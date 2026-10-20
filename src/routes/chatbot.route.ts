import { Router } from 'express';
import chatBotController from '../app/http/controllers/chatbot.controller';
import { checkPlanLimit } from '@surefy/middleware/plan.middleware';

const chatBotRoute = Router();

chatBotRoute.get('/templates/categories', chatBotController.templateCategories);
chatBotRoute.get('/templates', chatBotController.listTemplates);
chatBotRoute.get('/templates/:templateId', chatBotController.getTemplate);
chatBotRoute.post('/templates/:templateId/use', checkPlanLimit('Chatbot'), chatBotController.useTemplate);

chatBotRoute.post('/create', checkPlanLimit('Chatbot'), chatBotController.createChatBot);
chatBotRoute.post('/flow/:chatBotId', chatBotController.createChatBotFlow);
chatBotRoute.get('/', chatBotController.getChatBots);
chatBotRoute.patch('/:chatBotId/name', chatBotController.updateChatBotName);
chatBotRoute.put('/:chatBotId/publish', chatBotController.publishedChatBot);
chatBotRoute.put('/:chatBotId/unpublish', chatBotController.unpublishedChatBot);
chatBotRoute.get('/:chatBotId', chatBotController.getChatBotById);
chatBotRoute.delete('/:chatBotId', chatBotController.deleteChatBot);

export default chatBotRoute;
