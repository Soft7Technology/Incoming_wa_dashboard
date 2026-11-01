import { Router } from 'express';
import instagram from '../app/http/controllers/instagram.controller';
import { metaError, noStore } from '../app/http/controllers/metaHttp.controller';

const route = Router();
route.use(noStore);
route.use((_req, res, next) => {
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});
route.get('/instagram/publishing/media/:token', instagram.publishingMedia);
route.get('/instagram/oauth/callback', instagram.callback);
route.get('/instagram/webhook', instagram.verify);
route.post('/instagram/webhook', instagram.receive);
route.post('/instagram/deauthorize', instagram.deauthorize);
route.post('/instagram/data-deletion', instagram.deletion);
route.get('/data-deletion/status/:confirmation', instagram.deletionStatus);
route.use(metaError);
export default route;
