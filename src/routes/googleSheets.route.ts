import { Router } from 'express';
import { requireRole } from '@surefy/middleware/jwtAuth.middleware';
import { accountScope } from '../app/http/middleware/accountScope';
import controller, { noStore } from '../app/http/controllers/googleSheets.controller';

const route = Router();
// JWT authentication is supplied by AdminRoute. Shared connections are owner-managed.
route.use(accountScope, requireRole('user'), noStore);
route.get('/setup', controller.setup);
route.post('/oauth/start', controller.start);
route.get('/connection', controller.connection);
route.delete('/connection', controller.disconnect);
route.get('/picker-token', controller.pickerToken);
route.get('/spreadsheets', controller.spreadsheets);
route.get('/spreadsheets/:id/tabs', controller.tabs);
route.get('/spreadsheets/:id/tabs/:sheetId/preview', controller.sample);
route.post('/preview', controller.preview);
route.get('/snapshots', controller.snapshots);
route.post('/snapshots/:id/import', controller.importSnapshot);
route.get('/snapshots/:id/import', controller.importStatus);
route.post('/campaigns/bulk', controller.bulkCampaigns);
route.post('/campaigns', controller.campaign);
export default route;
