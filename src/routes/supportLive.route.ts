import { Router } from 'express';
import controller from '../app/http/controllers/supportLive.controller';

// Mounted below the existing JWT-protected /v1/admin/support group.
const route = Router();
route.get('/admins', controller.admins);
route.get('/events', controller.events);
route.get('/tickets', controller.list);
route.post('/tickets', controller.create);
route.get('/tickets/:ticketId', controller.get);
route.get('/tickets/:ticketId/messages', controller.messages);
route.post('/tickets/:ticketId/messages', controller.reply);
route.post('/tickets/:ticketId/join', controller.join);
route.patch('/tickets/:ticketId/assignment', controller.assign);
route.patch('/tickets/:ticketId/status', controller.status);

export default route;
