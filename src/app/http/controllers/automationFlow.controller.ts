import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import service from '../../services/automationFlow.service';

const scope = (req: JWTAuthRequest) => ({ userId: req.userId, companyId: req.companyId });
class AutomationFlowController {
  catalog = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Automation apps retrieved', await service.catalog(scope(req))));
  connections = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow connections retrieved', await service.connections(scope(req))));
  templates = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow templates retrieved', await service.templates(scope(req), req.params.connectionId)));
  createConnection = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow connection saved', await service.createConnection(scope(req), req.body), 201));
  disconnect = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow connection disconnected', await service.disconnect(scope(req), req.params.connectionId)));
  create = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow created', await service.create(scope(req), req.body), 201));
  list = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flows retrieved', await service.list(scope(req), req.query)));
  get = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow retrieved', await service.get(scope(req), req.params.flowId)));
  update = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow updated', await service.update(scope(req), req.params.flowId, req.body)));
  remove = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow deleted', await service.remove(scope(req), req.params.flowId)));
  status = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow status updated', await service.status(scope(req), req.params.flowId, req.body)));
  saveSteps = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow steps saved', await service.saveSteps(scope(req), req.params.flowId, req.body)));
  addStep = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow step added', await service.saveSteps(scope(req), req.params.flowId, req.body, undefined, true), 201));
  updateStep = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow step saved', await service.saveSteps(scope(req), req.params.flowId, req.body, req.params.stepId)));
  removeStep = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow step deleted', await service.removeStep(scope(req), req.params.flowId, req.params.stepId, req.body?.revision)));
  webhook = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow webhook configured', await service.configureWebhook(scope(req), req.params.flowId, req.body)));
  subscribeWebhook = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Shopify flow webhook registered', await service.subscribeWebhook(scope(req), req.params.flowId, req.body || {})));
  webhookStatus = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Shopify flow webhook status retrieved', await service.webhookStatus(scope(req), req.params.flowId)));
  unsubscribeWebhook = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Shopify flow webhook removed', await service.unsubscribeWebhook(scope(req), req.params.flowId, req.body || {})));
  events = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow events retrieved', await service.events(scope(req), req.params.flowId)));
  event = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow event retrieved', await service.events(scope(req), req.params.flowId, req.params.eventId)));
  testRun = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow test run queued', await service.testRun(scope(req), req.params.flowId, req.body), 202));
  runs = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow runs retrieved', await service.runs(scope(req), req.params.flowId)));
  run = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Flow run retrieved', await service.runs(scope(req), req.params.flowId, req.params.runId)));
  receive = tryCatchAsync(async (req: JWTAuthRequest & { rawBody?: Buffer }, res: Response) => {
    const result = await service.receive(req.params.flowId, req.params.token, req.rawBody!, req.headers);
    res.status(200).json({ success: true, data: result });
  });
}
export default new AutomationFlowController();
