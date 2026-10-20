import { Router } from 'express';
import path from 'path';
import FacebookReviewLoginRoute from './facebookReviewLogin.route';
import controller, { facebookError } from '../app/http/controllers/facebookMessenger.controller';
import leads from '../app/http/controllers/facebookLeads.controller';
import instagram from '../app/http/controllers/instagram.controller';
import content from '../app/http/controllers/facebookContent.controller';

const route = Router();
route.use(controller.noStore);
route.use((_req, res, next) => {
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});
route.get('/page', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/index.html')));
route.get('/posts', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/posts.html')));
route.get('/posts.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/posts.js')));
route.get('/posts/oauth/callback', content.callback);
route.get('/leads', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/leads.html')));
route.get('/instagram', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/instagram.html')));
route.get('/instagram.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/instagram.js')));
route.get('/instagram/publishing/media/:token', instagram.publishingMedia);
route.get('/instagram/oauth/callback', instagram.callback);
route.get('/instagram/webhook', instagram.verify);
route.post('/instagram/webhook', instagram.receive);
route.post('/instagram/deauthorize', instagram.deauthorize);
route.post('/instagram/data-deletion', instagram.deletion);
route.get('/leads.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/leads.js')));
route.get('/leads/oauth/callback', leads.callback);
route.get('/app.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/app.js')));
route.get('/style.css', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/style.css')));
route.use('/review-login', FacebookReviewLoginRoute);
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
