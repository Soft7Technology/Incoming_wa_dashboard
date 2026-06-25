import { Router } from 'express';
import { uploadXLSXMiddleware } from '@surefy/middleware/upload.middleware';
import ContactController from '@surefy/console/http/controllers/contact.controller';
import { checkPlanLimit } from '@surefy/middleware/plan.middleware';
import { requireRole } from '@surefy/middleware/jwtAuth.middleware';

const ContactRoute = Router();

// All contact endpoints require authentication (applied at route group level)

// Lists management
ContactRoute.get('/lists',  ContactController.getLists);
ContactRoute.get('/lists/:id', ContactController.getListById);
ContactRoute.get('/lists/:id/contacts', ContactController.getListContacts);
ContactRoute.delete('/lists/:id', ContactController.deleteList);

// Tags CRUD
ContactRoute.post('/tags', ContactController.createTag);
ContactRoute.get('/tags', ContactController.getTags);
ContactRoute.put('/tags/:id', ContactController.updateTag);
ContactRoute.delete('/tags/:id', ContactController.deleteTag);

// Contact CRUD
ContactRoute.post('/', checkPlanLimit('Contact'), ContactController.createContact);
ContactRoute.get('/', ContactController.getContacts);
ContactRoute.get('/team/accepted', ContactController.getAcceptedTeamMembers);
ContactRoute.patch('/assign', ContactController.assignContact);
ContactRoute.get('/:id', ContactController.getContactById);
ContactRoute.put('/:id', requireRole('user','member'),ContactController.updateContact);
ContactRoute.delete('/:id',requireRole('user','member'), ContactController.deleteContact);
ContactRoute.get('/user/:userId', ContactController.getUsersContacts)
ContactRoute.put('/:contactId/assigned',ContactController.assignedContactToUser)

// Contact importc
ContactRoute.get('/import/sample', ContactController.downloadSampleTemplate);
ContactRoute.get('/import/jobs', ContactController.getImportJobs);
ContactRoute.get('/import/:jobId/status', ContactController.getImportStatus);
ContactRoute.post('/import/preview', uploadXLSXMiddleware, ContactController.previewImport);
ContactRoute.post('/import',checkPlanLimit('Contact'), uploadXLSXMiddleware, ContactController.importContacts);

// Contact tags management
ContactRoute.post('/:id/tags',checkPlanLimit('Tag'), ContactController.addTags);
ContactRoute.delete('/:id/tags', ContactController.removeTags);

export default ContactRoute;


