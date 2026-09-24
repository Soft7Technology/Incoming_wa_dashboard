import { accountScope, ownedResource, ownedPhone, accountAssignments } from '../app/http/middleware/accountScope';
import { Router } from 'express';
import { uploadXLSXMiddleware } from '@surefy/middleware/upload.middleware';
import ContactController from '@surefy/console/http/controllers/contact.controller';
import { checkPlanLimit } from '@surefy/middleware/plan.middleware';
import { requireRole } from '@surefy/middleware/jwtAuth.middleware';

const ContactRoute = Router();
ContactRoute.use(accountScope);

// All contact endpoints require authentication (applied at route group level)

// Lists management
ContactRoute.get('/lists',  ContactController.getLists);
ContactRoute.get('/lists/:id', ownedResource('contact_lists', 'id'), ContactController.getListById);
ContactRoute.get('/lists/:id/contacts', ownedResource('contact_lists', 'id'), ContactController.getListContacts);
ContactRoute.delete('/lists/:id', ownedResource('contact_lists', 'id'), ContactController.deleteList);

// Tags CRUD
ContactRoute.post('/tags', ContactController.createTag);
ContactRoute.get('/tags', ContactController.getTags);
ContactRoute.put('/tags/:id', ownedResource('contact_tags', 'id'), ContactController.updateTag);
ContactRoute.delete('/tags/:id', ownedResource('contact_tags', 'id'), ContactController.deleteTag);

// Contact CRUD
ContactRoute.post('/', ownedPhone, checkPlanLimit('Contact'), ContactController.createContact);
ContactRoute.get('/', ContactController.getContacts);
ContactRoute.get('/phone-number/:phoneNumberId', ownedPhone, ContactController.getContactByPhoneNumberId);
// Retain the existing phone-number URL; use /by-id/:id for contact detail.
ContactRoute.get('/:phoneNumberId', ownedPhone, ContactController.getContactByPhoneNumberId);
ContactRoute.get('/by-id/:id', ownedResource('contacts', 'id'), ContactController.getContactById);
ContactRoute.put('/:id', ownedResource('contacts', 'id'), accountAssignments, requireRole('user','member'),ContactController.updateContact);
ContactRoute.delete('/',requireRole('user','member'), ContactController.bulkDeleteContacts);
ContactRoute.delete('/:id', ownedResource('contacts', 'id'),requireRole('user','member'), ContactController.deleteContact);
ContactRoute.get('/user/:userId', ContactController.getUsersContacts)
ContactRoute.put('/:contactId/assigned', ownedResource('contacts', 'contactId'), accountAssignments,ContactController.assignedContactToUser)

// Contact import
ContactRoute.get('/import/sample', ContactController.downloadSampleTemplate);
ContactRoute.get('/import/jobs', ContactController.getImportJobs);
ContactRoute.get('/import/:jobId/status', ownedResource('import_jobs', 'jobId'), ContactController.getImportStatus);
ContactRoute.post('/import/preview', uploadXLSXMiddleware, ContactController.previewImport);
ContactRoute.post('/import', uploadXLSXMiddleware, ownedPhone, ContactController.importContacts);

// Contact tags management
// Adding existing tags does not consume the plan allowance for creating new tags.
ContactRoute.post('/bulk/tags', requireRole('user', 'member'), ContactController.addBulkTags);
ContactRoute.post('/:id/tags', ownedResource('contacts', 'id'),checkPlanLimit('Tag'), ContactController.addTags);
ContactRoute.delete('/:id/tags', ownedResource('contacts', 'id'), ContactController.removeTags);

export default ContactRoute;


