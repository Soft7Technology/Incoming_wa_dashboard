import { Router } from 'express';
import * as path from 'path';
import controller, { noStore } from '../app/http/controllers/googlePeople.controller';
const route = Router();
route.use(noStore);
route.get(['/app', '/test'], (_req, res) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.sendFile(path.resolve(__dirname, '../web/google-people/index.html'));
});
route.get('/app.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/google-people/app.js')));
route.get('/style.css', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/google-people/style.css')));
route.get('/setup', controller.publicSetup);
route.get('/callback', controller.callback);
export default route;
