import { Router } from 'express';
import chatBotController from '../app/http/controllers/chatbot.controller';
import { checkPlanLimit } from '@surefy/middleware/plan.middleware';

const chatBotRoute = Router()

// chatBotRoute.post('/create', checkPlanLimit('Chatbot'), chatBotController.createChatBot)
chatBotRoute.post('/create',chatBotController.createChatBot)
chatBotRoute.post('/flow/:chatBotId', chatBotController.createChatBotFlow)
chatBotRoute.get('/', chatBotController.getChatBots)
chatBotRoute.put('/:chatBotId/publish', chatBotController.publishedChatBot)
chatBotRoute.put('/:chatBotId/unpublish', chatBotController.unpublishedChatBot)
chatBotRoute.get('/:chatBotId', chatBotController.getChatBotById)
chatBotRoute.delete('/:chatBotId', chatBotController.deleteChatBot)
chatBotRoute.put('/:chatBotId/assigned',chatBotController.assigndChatBot)


export default chatBotRoute


