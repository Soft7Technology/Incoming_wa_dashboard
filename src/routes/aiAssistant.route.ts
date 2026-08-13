import { Router } from 'express';
import multer from 'multer';
import aiAssistantController from '../app/http/controllers/aiAssistant.controller';

const upload = multer({ dest: 'public/uploads/' }); // Temporary storage for extraction
const aiAssistantRoute = Router();

aiAssistantRoute.get('/', aiAssistantController.getAssistants);
aiAssistantRoute.post('/test-connection', aiAssistantController.testConnection);
aiAssistantRoute.post('/', upload.array('knowledgeFiles', 10), aiAssistantController.createAssistant);
aiAssistantRoute.put('/:id', upload.array('knowledgeFiles', 10), aiAssistantController.updateAssistant);
aiAssistantRoute.delete('/:id', aiAssistantController.deleteAssistant);

export default aiAssistantRoute;
