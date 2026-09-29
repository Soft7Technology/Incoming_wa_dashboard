import { Router } from 'express';
import TemplateController from '@surefy/console/http/controllers/template.controller';

const TemplateRoute = Router();

// All template endpoints require authentication (applied at route group level)

TemplateRoute.post('/sync', TemplateController.syncTemplates);
TemplateRoute.post('/create', TemplateController.createTemplate);
TemplateRoute.get('/', TemplateController.getTemplates);
TemplateRoute.patch('/:id', TemplateController.updateTemplate);
TemplateRoute.get('/:id', TemplateController.getTemplateById);
TemplateRoute.delete('/:id', TemplateController.deleteTemplate);

export default TemplateRoute;
