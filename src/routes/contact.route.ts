import { Router } from 'express';
import { uploadXLSXMiddleware } from '@surefy/middleware/upload.middleware';
import ContactController from '@surefy/console/http/controllers/contact.controller';

const ContactRoute = Router();

// All contact endpoints require authentication (applied at route group level)

// Lists management
ContactRoute.get('/lists', ContactController.getLists);
ContactRoute.get('/lists/:id', ContactController.getListById);
ContactRoute.get('/lists/:id/contacts', ContactController.getListContacts);
ContactRoute.delete('/lists/:id', ContactController.deleteList);

// Tags CRUD
ContactRoute.post('/tags', ContactController.createTag);
ContactRoute.get('/tags', ContactController.getTags);
ContactRoute.put('/tags/:id', ContactController.updateTag);
ContactRoute.delete('/tags/:id', ContactController.deleteTag);

// Contact CRUD
ContactRoute.post('/', ContactController.createContact);
ContactRoute.get('/', ContactController.getContacts);
ContactRoute.get('/:id', ContactController.getContactById);
ContactRoute.put('/:id', ContactController.updateContact);
ContactRoute.delete('/:id', ContactController.deleteContact);

// Contact import
ContactRoute.get('/import/sample', ContactController.downloadSampleTemplate);
ContactRoute.get('/import/jobs', ContactController.getImportJobs);
ContactRoute.get('/import/:jobId/status', ContactController.getImportStatus);
ContactRoute.post('/import/preview', uploadXLSXMiddleware, ContactController.previewImport);
ContactRoute.post('/import', uploadXLSXMiddleware, ContactController.importContacts);

// Contact tags management
ContactRoute.post('/:id/tags', ContactController.addTags);
ContactRoute.delete('/:id/tags', ContactController.removeTags);
// ContactRoute.get()




export default ContactRoute;
