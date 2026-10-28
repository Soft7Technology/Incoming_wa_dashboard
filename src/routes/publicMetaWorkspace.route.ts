import { Router, Request, RequestHandler } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import sessions, { publicMetaSessionLifetime } from '../app/services/publicMetaSession.service';
import { facebookError, facebookHandler } from '../app/http/controllers/facebookMessenger.controller';
import FacebookMessengerRoute from './facebookMessenger.route';
import FacebookContentRoute from './facebookContent.route';
import FacebookLeadsRoute from './facebookLeads.route';
import InstagramRoute from './instagram.route';

const route = Router();
const cookieName = 'public_meta_workspace';
const cookie = (req: Request) => req.headers.cookie?.split(';').map(part => part.trim())
  .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);

// The public UI uses same-origin cookies. Only this route accepts them; dashboard
// APIs still require their normal JWT. Do not accept cross-origin browser calls.
const sameOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  const site = req.get('sec-fetch-site');
  let permitted = !site || site === 'same-origin' || site === 'none';
  if (origin) {
    try { permitted = permitted && new URL(origin).host === req.get('host'); }
    catch { permitted = false; }
  }
  if (!permitted) {
    res.status(403).json({ success: false, message: 'Open this workspace on its own website.' });
    return;
  }
  const contentType = req.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['GET', 'HEAD'].includes(req.method) &&
      contentType !== 'application/json' && contentType !== 'multipart/form-data') {
    res.status(415).json({ success: false, message: 'Send JSON or a media upload from the workspace.' });
    return;
  }
  next();
};

route.use(['/session', '/api'], sameOrigin);
route.post('/session', facebookHandler(async (req, res) => {
  const result = await sessions.start(cookie(req));
  const secure = req.secure || process.env.NODE_ENV === 'production' ||
    (process.env.FACEBOOK_PUBLIC_URL || process.env.INSTAGRAM_PUBLIC_URL || '').startsWith('https://');
  res.cookie(cookieName, result.token, { httpOnly: true, secure,
    sameSite: 'lax', path: '/v1/facebook', maxAge: publicMetaSessionLifetime });
  res.json({ success: true, data: { ready: true } });
}));
route.use('/api', async (req: JWTAuthRequest, res, next) => {
  try {
    const scope = await sessions.find(cookie(req));
    if (!scope) {
      res.status(401).json({ success: false, message: 'Your workspace session expired. Reload this page to continue.' });
      return;
    }
    Object.assign(req, scope, { userRole: 'company' });
    next();
  } catch (error) { next(error); }
});
route.use('/api/messenger', FacebookMessengerRoute);
route.use('/api/posts', FacebookContentRoute);
route.use('/api/leads', FacebookLeadsRoute);
route.use('/api/instagram', InstagramRoute);
route.use(facebookError);

export default route;
