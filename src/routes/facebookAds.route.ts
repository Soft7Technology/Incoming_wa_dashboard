import { Router } from 'express';
import controller from '../app/http/controllers/facebookAds.controller';
import { facebookError } from '../app/http/controllers/facebookMessenger.controller';

const route = Router();
route.get('/setup', controller.setup);
route.get('/status', controller.status);
route.post('/oauth/start', controller.start);
route.post('/disconnect', controller.disconnect);
route.get('/businesses', controller.businesses);
route.get('/businesses/:business/accounts', controller.accounts);
route.get('/businesses/:business/accounts/:account/campaigns', controller.campaigns);
route.get('/businesses/:business/accounts/:account/insights', controller.insights);
route.post('/businesses/:business/accounts/:account/campaigns', controller.create);
route.use(facebookError);
export default route;
