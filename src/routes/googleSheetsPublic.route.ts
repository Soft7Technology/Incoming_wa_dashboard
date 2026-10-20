import { Router } from 'express';
import * as path from 'path';
import controller, { noStore } from '../app/http/controllers/googleSheets.controller';
const route = Router();
route.use(noStore);
route.get('/test', (_req, res) => {
  // Website-restricted Picker keys need an origin referrer. OAuth callbacks
  // retain no-referrer so authorization codes never reach external resources.
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'self' https://apis.google.com https://www.gstatic.com",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https://*.googleapis.com https://apis.google.com",
      'frame-src https://docs.google.com https://drive.google.com https://accounts.google.com',
      "img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.sendFile(path.resolve(__dirname, '../web/google-sheets/index.html'));
});
route.get('/test.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/google-sheets/app.js')));
route.get('/test.css', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/google-sheets/style.css')));
route.get('/test-config', controller.testConfig);
route.get('/callback', controller.callback);
export default route;
