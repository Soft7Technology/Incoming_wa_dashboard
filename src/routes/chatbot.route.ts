import { Router } from 'express';
import chatBotController from '../app/http/controllers/chatbot.controller';

const chatBotRoute = Router()

chatBotRoute.post('/create',chatBotController.createChatBot)
chatBotRoute.post('/flow/:chatBotId', chatBotController.createChatBotFlow)

export default chatBotRoute


