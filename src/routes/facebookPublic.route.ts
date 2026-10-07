import { Router } from 'express';
import path from 'path';
import FacebookLoginTestRoute from './facebookLoginTest.route';
import controller, { facebookError } from '../app/http/controllers/facebookMessenger.controller';

const route = Router();
route.use('/login-test', FacebookLoginTestRoute);
route.use(controller.noStore);
route.use((_req, res, next) => {
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});
route.get('/page', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/index.html')));
route.get('/app.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/app.js')));
route.get('/style.css', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/style.css')));
route.get('/oauth/callback', controller.callback);
route.get('/webhook', controller.verify);
route.post('/webhook', controller.receive);
route.post('/deauthorize', controller.deauthorize);
route.post('/data-deletion', controller.deletion);
route.get('/data-deletion', controller.deletionInstructions);
route.get('/data-deletion/status/:confirmation', controller.deletionStatus);
route.get('/privacy', controller.privacy);
route.use(facebookError);
export default route;
