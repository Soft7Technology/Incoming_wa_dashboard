import { Router } from 'express';
import * as path from 'path';
import controller, { noStore } from '../app/http/controllers/shopify.controller';
const route = Router();
route.use(noStore);
route.get(['/app', '/test'], (_req, res) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.sendFile(path.resolve(__dirname, '../web/shopify/index.html'));
});
route.get('/test.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/shopify/app.js')));
route.get('/test.css', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/shopify/style.css')));
route.get('/test-config', controller.setup);
route.get('/privacy', controller.privacy);
route.get('/callback', controller.callback);
route.post('/webhook', controller.receive);
route.get('/webhook/flows/:flowId/:token', controller.testFlowStatus);
route.post('/webhook/flows/:flowId/:token', controller.receiveTestFlow);
route.post('/webhook/:id/:token', controller.receive);
export default route;
