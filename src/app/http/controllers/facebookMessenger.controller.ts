import { Request, Response, NextFunction, RequestHandler } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import service, { FacebookScope } from '../../services/facebookMessenger.service';
import {
  config,
  FacebookError,
  permissions,
  publicOrigin,
  signedUser,
  subscriptions,
  verifySignature,
} from '../../utils/facebook';

export const facebookHandler =
  (fn: (req: JWTAuthRequest, res: Response) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };

export function facebookError(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const e =
    error instanceof FacebookError ? error : new FacebookError(500, 'Facebook operation failed. Please try again.');
  // Do not let the generic error handler log database bindings or HTTP request secrets.
  if (!(error instanceof FacebookError))
    console.error('[Facebook] Operation failed; details suppressed to protect credentials.');
  res.status(e.status).json({ success: false, message: e.message, code: e.code });
}

const scope = (req: JWTAuthRequest): FacebookScope => ({
  companyId: req.companyId!,
  ownerId: (req.ownerId || req.userId)!,
  userId: req.userId!,
});
const browser = (req: Request) => {
  const value = req.headers.cookie
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('fb_browser='))
    ?.slice(11);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
};
const ok = (res: Response, data: unknown) => res.json({ success: true, data });
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

class FacebookMessengerController {
  noStore: RequestHandler = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  };
  setup = facebookHandler(async (req, res) => {
    await service.access(scope(req), 'inbox');
    let ready = true,
      issue: string | null = null;
    try {
      config();
    } catch (error) {
      ready = false;
      issue = error instanceof FacebookError ? error.message : 'Invalid Facebook configuration.';
    }
    let canManage = false;
    try {
      await service.access(scope(req), 'manage');
      canManage = true;
    } catch (error) {
      if (!(error instanceof FacebookError) || error.status !== 403) throw error;
    }
    ok(res, {
      ready,
      issue,
      can_manage: canManage,
      permissions,
      subscriptions,
      privacy_ready: Boolean(process.env.FACEBOOK_PRIVACY_CONTROLLER && process.env.FACEBOOK_PRIVACY_EMAIL),
      login_mode: process.env.FACEBOOK_LOGIN_MODE === 'classic' ? 'classic' : 'business',
    });
  });
  start = facebookHandler(async (req, res) => {
    const result = await service.start(scope(req));
    res.cookie('fb_browser', result.browser, {
      httpOnly: true,
      secure: config().secure,
      sameSite: 'lax',
      path: '/v1',
      maxAge: 15 * 60 * 1000,
    });
    ok(res, { authorization_url: result.url });
  });
  callback = facebookHandler(async (req, res) => {
    const result = await service.callback(req.query.state, browser(req), req.query.code, Boolean(req.query.error));
    res.redirect(303, `/v1/facebook/page#oauth=${result}`);
  });
  candidates = facebookHandler(async (req, res) => ok(res, await service.candidates(scope(req), browser(req))));
  connect = facebookHandler(async (req, res) =>
    ok(res, await service.connect(scope(req), browser(req), req.body?.page_id)),
  );
  pages = facebookHandler(async (req, res) => ok(res, await service.pages(scope(req))));
  disconnect = facebookHandler(async (req, res) => ok(res, await service.disconnect(scope(req), req.params.id)));
  erase = facebookHandler(async (req, res) => ok(res, await service.disconnect(scope(req), req.params.id, true)));
  conversations = facebookHandler(async (req, res) =>
    ok(
      res,
      await service.conversations(scope(req), typeof req.query.before === 'string' ? req.query.before : undefined),
    ),
  );
  messages = facebookHandler(async (req, res) =>
    ok(
      res,
      await service.messages(
        scope(req),
        req.params.id,
        typeof req.query.before === 'string' ? req.query.before : undefined,
      ),
    ),
  );
  send = facebookHandler(async (req, res) =>
    ok(res, await service.send(scope(req), req.params.id, req.body?.text, req.body?.client_request_id)),
  );

  verify = facebookHandler(async (req, res) => {
    const expected = process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN;
    if (!expected) throw new FacebookError(503, 'Facebook webhook verification is not configured.');
    if (
      req.query['hub.mode'] !== 'subscribe' ||
      req.query['hub.verify_token'] !== expected ||
      typeof req.query['hub.challenge'] !== 'string'
    ) {
      throw new FacebookError(403, 'Webhook verification failed.');
    }
    res.type('text/plain').send(req.query['hub.challenge']);
  });
  receive = facebookHandler(async (req, res) => {
    const secret = process.env.FACEBOOK_APP_SECRET;
    if (!secret) throw new FacebookError(503, 'Facebook webhook is not configured.');
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw || !verifySignature(raw, req.headers['x-hub-signature-256'], secret))
      throw new FacebookError(403, 'Invalid Facebook webhook signature.');
    // Acknowledge only after persistence. Failure returns 5xx so Meta can redeliver.
    await service.receive(req.body);
    res.status(200).type('text/plain').send('EVENT_RECEIVED');
  });
  deauthorize = facebookHandler(async (req, res) => {
    if (!process.env.FACEBOOK_APP_SECRET) throw new FacebookError(503, 'Facebook is not configured.');
    await service.revoke(signedUser(req.body?.signed_request, process.env.FACEBOOK_APP_SECRET), false);
    ok(res, { deauthorized: true });
  });
  deletion = facebookHandler(async (req, res) => {
    if (!process.env.FACEBOOK_APP_SECRET) throw new FacebookError(503, 'Facebook is not configured.');
    const { base } = publicOrigin();
    const confirmation = await service.revoke(
      signedUser(req.body?.signed_request, process.env.FACEBOOK_APP_SECRET),
      true,
    );
    res.json({ url: `${base}/v1/facebook/data-deletion/status/${confirmation}`, confirmation_code: confirmation });
  });
  deletionStatus = facebookHandler(async (req, res) => {
    const data = await service.deletionStatus(req.params.confirmation);
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Facebook data deletion</title><h1>Facebook data deletion completed</h1><p>Connected Page credentials, conversations and messages linked to this Facebook authorization were deleted from the active application database.</p><p>Completed: ${escape(new Date(data.completed_at).toISOString())}</p></html>`,
      );
  });
  privacy = facebookHandler(async (_req, res) => {
    const controller = process.env.FACEBOOK_PRIVACY_CONTROLLER,
      email = process.env.FACEBOOK_PRIVACY_EMAIL;
    if (!controller || !email)
      throw new FacebookError(
        503,
        'Set FACEBOOK_PRIVACY_CONTROLLER and FACEBOOK_PRIVACY_EMAIL before publishing this privacy notice.',
      );
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Messenger integration privacy notice</title><main><h1>Messenger integration privacy notice</h1><p>${escape(controller)} operates this customer support integration. Contact: ${escape(email)}.</p><p>When a business connects a Page, we store its Page ID and name, the authorizing Facebook user ID and an encrypted Page access token. For customer-initiated conversations we store Page-scoped customer identifiers, message content, timestamps and delivery/read events. We use this information to display support conversations to authorized business agents and send their replies through Meta.</p><p>Data is shared with Meta to provide Messenger replies and with the business operating the connected Page. Access is limited to the owning account and its authorized team. Tokens are stored encrypted and are never displayed in the dashboard.</p><p>Disconnect removes stored credentials and stops receiving new messages. Conversation history is retained until the business deletes the integration. Deauthorizing in Facebook removes credentials; a verified Facebook data-deletion request removes all stored Pages and conversations linked to the requesting authorization. Businesses can also choose Delete stored integration in Settings. Contact us to request customer-message deletion; identify the Page and conversation without sending passwords or tokens.</p><p>This notice covers this Messenger integration. The business's own privacy notice and the SaaS's broader privacy policy also apply. The deployment operator is responsible for describing hosting providers, backup retention and any additional processing in its main policy.</p><p><a href="/v1/facebook/data-deletion">Data deletion instructions</a></p></main></html>`,
      );
  });
  deletionInstructions = facebookHandler(async (_req, res) => {
    const email = process.env.FACEBOOK_PRIVACY_EMAIL;
    if (!email) throw new FacebookError(503, 'The privacy contact must be configured.');
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Facebook data deletion instructions</title><h1>Delete Facebook integration data</h1><p>Log into this application and open Settings → Integrations → Facebook Messenger. Choose Delete stored integration on the Page card. This disconnects the Page and deletes its stored credentials, conversations and messages from the active database.</p><p>You can also remove the app in Facebook Business Integrations and request deletion through Facebook. We verify Facebook's signed request, delete data linked to that authorization and return a confirmation URL.</p><p>For customer-message deletion or assistance contact ${escape(email)} with the Page and conversation details. Do not send passwords or tokens. Ask the operator about its backup retention policy.</p></html>`,
      );
  });
}
export default new FacebookMessengerController();
