import { Router } from 'express';
import aiAssistantController from '../app/http/controllers/aiAssistant.controller';

const aiAssistantRoute = Router();

aiAssistantRoute.get('/', aiAssistantController.getAssistants);
aiAssistantRoute.post('/test-connection', aiAssistantController.testConnection);
aiAssistantRoute.post('/', aiAssistantController.createAssistant);
aiAssistantRoute.put('/:id', aiAssistantController.updateAssistant);
aiAssistantRoute.delete('/:id', aiAssistantController.deleteAssistant);

export default aiAssistantRoute;