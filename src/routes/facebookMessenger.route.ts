import { Router } from 'express';
import controller, { facebookError } from '../app/http/controllers/facebookMessenger.controller';

const route = Router();
route.use(controller.noStore);
route.get('/setup', controller.setup);
route.post('/oauth/start', controller.start);
route.get('/oauth/pages', controller.candidates);
route.post('/pages', controller.connect);
route.get('/pages', controller.pages);
route.post('/pages/:id/disconnect', controller.disconnect);
route.delete('/pages/:id', controller.erase);
route.get('/conversations', controller.conversations);
route.get('/conversations/:id/messages', controller.messages);
route.post('/conversations/:id/messages', controller.send);
route.use(facebookError);
export default route;
