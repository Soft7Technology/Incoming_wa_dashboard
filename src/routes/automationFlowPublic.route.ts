import { Router } from 'express';
import controller from '../app/http/controllers/automationFlow.controller';
const route = Router();
// Provider authentication uses the raw-body signature and an unguessable per-flow destination.
route.post('/flows/:flowId/:token', controller.receive);
export default route;
