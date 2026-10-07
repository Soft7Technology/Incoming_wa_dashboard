import { Router, Request, Response, RequestHandler } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';

// A developer-only OAuth test, independent of SaaS accounts and Messenger storage.
const route = Router();
const root = '/v1/facebook/login-test';
const stateCookie = 'fb_login_test_state';
const profileCookie = 'fb_login_test_profile';
const pending = new Map<string, number>();
const ttl = 10 * 60 * 1000;

function settings() {
  const required = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_GRAPH_VERSION'];
  const mode = process.env.FACEBOOK_TEST_LOGIN_MODE || 'classic';
  if (!['classic', 'business'].includes(mode)) throw new Error('FACEBOOK_TEST_LOGIN_MODE must be classic or business.');
  if (mode === 'business') required.push('FACEBOOK_LOGIN_CONFIG_ID');
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Add these values to .env and restart: ${missing.join(', ')}.`);
  if (!/^\d+$/.test(process.env.FACEBOOK_APP_ID!) || !/^v\d+\.\d+$/.test(process.env.FACEBOOK_GRAPH_VERSION!))
    throw new Error('Use a numeric FACEBOOK_APP_ID and an active FACEBOOK_GRAPH_VERSION from your Meta app (vXX.0).');
  if (mode === 'business' && !/^\d+$/.test(process.env.FACEBOOK_LOGIN_CONFIG_ID!))
    throw new Error('FACEBOOK_LOGIN_CONFIG_ID must be numeric.');
  const url = new URL(
    process.env.FACEBOOK_TEST_PUBLIC_URL ||
      process.env.FACEBOOK_PUBLIC_URL ||
      `http://localhost:${process.env.PORT || '3001'}`,
  );
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('FACEBOOK_TEST_PUBLIC_URL must be an HTTPS origin, or HTTP localhost for development.');
  return {
    appId: process.env.FACEBOOK_APP_ID!,
    secret: process.env.FACEBOOK_APP_SECRET!,
    version: process.env.FACEBOOK_GRAPH_VERSION!,
    mode,
    origin: url.origin,
    callback: `${url.origin}${root}/callback`,
    secure: url.protocol === 'https:',
  };
}

function cookie(req: Request, name: string) {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + '='))
    ?.slice(name.length + 1);
}
function cookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: root };
}
const sign = (value: string, secret: string) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
function profile(req: Request, secret: string) {
  try {
    const [payload, signature, extra] = (cookie(req, profileCookie) || '').split('.');
    if (!payload || !signature || extra) return null;
    const supplied = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(sign(payload, secret), 'base64url');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.expires > Date.now() ? data : null;
  } catch {
    return null;
  }
}
const handler =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };

route.use((_req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    res.sendStatus(404);
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});
route.get('/', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/login-test.html')));
route.get('/app.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/login-test.js')));
route.get('/style.css', (_req, res) => res.sendFile(path.resolve(__dirname, '../web/facebook/login-test.css')));
route.get('/config', (_req, res) => {
  try {
    const c = settings();
    res.json({
      ready: true,
      app_id: c.appId,
      version: c.version,
      mode: c.mode,
      callback: c.callback,
      profile: profile(_req, c.secret),
    });
  } catch (error) {
    res.json({ ready: false, issue: error instanceof Error ? error.message : 'Invalid test configuration.' });
  }
});
route.post('/start', (req, res) => {
  let c: ReturnType<typeof settings>;
  try {
    c = settings();
  } catch {
    res.status(503).json({ message: 'Configure Facebook login first, then restart the server.' });
    return;
  }
  if (req.headers.origin !== c.origin) {
    res.status(403).json({ message: 'Open the page at your configured test origin.' });
    return;
  }
  const now = Date.now();
  pending.forEach((expires, state) => {
    if (expires <= now) pending.delete(state);
  });
  const oldState = cookie(req, stateCookie);
  if (oldState) pending.delete(oldState);
  if (pending.size >= 1000) {
    res.status(429).json({ message: 'Too many pending logins. Try again in ten minutes.' });
    return;
  }
  const state = crypto.randomBytes(32).toString('base64url');
  pending.set(state, now + ttl);
  res.cookie(stateCookie, state, { ...cookieOptions(c.secure), maxAge: ttl });
  const url = new URL(`https://www.facebook.com/${c.version}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: c.appId,
    redirect_uri: c.callback,
    state,
    response_type: 'code',
    ...(c.mode === 'business' ? { config_id: process.env.FACEBOOK_LOGIN_CONFIG_ID! } : { scope: 'public_profile' }),
  }).toString();
  res.json({ url: url.toString() });
});
route.get(
  '/callback',
  handler(async (req, res) => {
    const c = settings();
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const bound = cookie(req, stateCookie);
    const expires = pending.get(state) || 0;
    // Reject another browser's state without consuming its legitimate login.
    if (!state || bound !== state || expires <= Date.now()) {
      res.redirect(`${root}?result=invalid_state`);
      return;
    }
    pending.delete(state);
    res.clearCookie(stateCookie, cookieOptions(c.secure));
    if (req.query.error) {
      res.redirect(`${root}?result=cancelled`);
      return;
    }
    if (typeof req.query.code !== 'string' || req.query.code.length > 4096) {
      res.redirect(`${root}?result=failed`);
      return;
    }
    try {
      // Exchange on the server. Never log or return the code, secret or access token.
      const graph = `https://graph.facebook.com/${c.version}`;
      const options = { timeout: 15000, maxRedirects: 0, maxContentLength: 1024 * 1024 };
      const exchanged = await axios.post(
        `${graph}/oauth/access_token`,
        new URLSearchParams({
          client_id: c.appId,
          client_secret: c.secret,
          redirect_uri: c.callback,
          code: req.query.code,
        }).toString(),
        { ...options, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      const token = exchanged.data?.access_token;
      if (typeof token !== 'string') throw new Error('Missing token');
      const authenticated = { ...options, headers: { Authorization: `Bearer ${token}` } };
      const proof = crypto.createHmac('sha256', c.secret).update(token).digest('hex');
      const user = await axios.get(`${graph}/me`, {
        ...authenticated,
        params: { fields: 'id,name', appsecret_proof: proof },
      });
      const grants = await axios.get(`${graph}/me/permissions`, {
        ...authenticated,
        params: { appsecret_proof: proof },
      });
      if (typeof user.data?.id !== 'string' || typeof user.data?.name !== 'string') throw new Error('Missing profile');
      const data = {
        id: user.data.id,
        name: user.data.name,
        permissions: (grants.data?.data || []).map((p: any) => ({
          permission: String(p.permission),
          status: String(p.status),
        })),
        expires: Date.now() + ttl,
      };
      const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
      if (payload.length > 3000) throw new Error('Profile too large');
      res.cookie(profileCookie, `${payload}.${sign(payload, c.secret)}`, { ...cookieOptions(c.secure), maxAge: ttl });
      res.redirect(`${root}?result=success`);
    } catch {
      res.redirect(`${root}?result=failed`);
    }
  }),
);
route.post('/logout', (req, res) => {
  const c = settings();
  if (req.headers.origin !== c.origin) {
    res.sendStatus(403);
    return;
  }
  const state = cookie(req, stateCookie);
  if (state) pending.delete(state);
  res.clearCookie(profileCookie, cookieOptions(c.secure));
  res.clearCookie(stateCookie, cookieOptions(c.secure));
  res.json({ success: true });
});
route.use((_error: unknown, _req: Request, res: Response, _next: unknown) => {
  res.status(503).json({ message: 'Facebook test login is unavailable. Check your app configuration and retry.' });
});
export default route;
