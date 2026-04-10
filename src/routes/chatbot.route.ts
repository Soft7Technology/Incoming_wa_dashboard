import { Router } from 'express';
import chatBotController from '../app/http/controllers/chatbot.controller';

const chatBotRoute = Router()

chatBotRoute.post('/create',chatBotController.createChatBot)
chatBotRoute.post('/flow/:chatBotId', chatBotController.createChatBotFlow)
chatBotRoute.get('/', chatBotController.getChatBots)
chatBotRoute.put('/:chatBotId/published', chatBotController.publishedChatBot)
chatBotRoute.put('/:chatBotId/unpublish', chatBotController.unpublishedChatBot)
chatBotRoute.get('/:chatBotId', chatBotController.getChatBotById)
chatBotRoute.delete('/:chatBotId', chatBotController.deleteChatBot)

export default chatBotRoute


