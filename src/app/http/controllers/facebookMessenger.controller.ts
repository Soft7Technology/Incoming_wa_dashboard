import { Request, Response, NextFunction, RequestHandler } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import service, { FacebookScope } from '../../services/facebookMessenger.service';
import leads from '../../services/facebookLeads.service';
import instagram from '../../services/instagram.service';
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
  reviewPageId: req.facebookReviewPageId,
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
      public_review: Boolean(req.facebookReviewPageId),
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
    const instagramSecret = process.env.INSTAGRAM_APP_SECRET;
    if (!secret && !instagramSecret) throw new FacebookError(503, 'Meta webhook is not configured.');
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const signature = req.headers['x-hub-signature-256'];
    const facebookSigned = Boolean(raw && secret && verifySignature(raw, signature, secret));
    const instagramSigned = Boolean(raw && instagramSecret && verifySignature(raw, signature, instagramSecret));
    if (!facebookSigned && !(instagramSigned && req.body?.object === 'instagram'))
      throw new FacebookError(403, 'Invalid Facebook webhook signature.');
    // Acknowledge only after persistence. Failure returns 5xx so Meta can redeliver.
    if (facebookSigned) {
      await service.receive(req.body);
      await leads.receive(req.body);
      await instagram.receive(req.body, 'facebook');
    }
    // Retried events and existing Meta callback settings can still use this
    // shared URL. Route direct Instagram events only after verifying its secret.
    if (instagramSigned && req.body?.object === 'instagram') await instagram.receive(req.body, 'instagram');
    res.status(200).type('text/plain').send('EVENT_RECEIVED');
  });
  deauthorize = facebookHandler(async (req, res) => {
    if (!process.env.FACEBOOK_APP_SECRET) throw new FacebookError(503, 'Facebook is not configured.');
    const user = signedUser(req.body?.signed_request, process.env.FACEBOOK_APP_SECRET);
    await instagram.revoke(user, false);
    await leads.revoke(user, false);
    await service.revoke(user, false);
    ok(res, { deauthorized: true });
  });
  deletion = facebookHandler(async (req, res) => {
    if (!process.env.FACEBOOK_APP_SECRET) throw new FacebookError(503, 'Facebook is not configured.');
    const { base } = publicOrigin();
    const user = signedUser(req.body?.signed_request, process.env.FACEBOOK_APP_SECRET);
    await instagram.revoke(user, true);
    await leads.revoke(user, true);
    const confirmation = await service.revoke(user, true);
    res.json({ url: `${base}/v1/facebook/data-deletion/status/${confirmation}`, confirmation_code: confirmation });
  });
  deletionStatus = facebookHandler(async (req, res) => {
    const data = await service.deletionStatus(req.params.confirmation);
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Facebook data deletion</title><h1>Facebook data deletion completed</h1><p>Connected Page credentials, conversations, messages, lead forms, submitted leads, Page posts integration data, Business &amp; Ads authorization and action records, and Instagram accounts, messages, posts and comments linked to this Facebook authorization were deleted from the active application database.</p><p>Completed: ${escape(new Date(data.completed_at).toISOString())}</p></html>`,
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
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Facebook integrations privacy notice</title><main><h1>Facebook integrations privacy notice</h1><p>${escape(controller)} operates this customer support integration. Contact: ${escape(email)}.</p><p>When a business connects a Page, we store its Page ID and name, the authorizing Facebook user ID and an encrypted Page access token. For customer-initiated conversations we store Page-scoped customer identifiers, message content, timestamps and delivery/read events. We use this information to display support conversations to authorized business agents and send their replies through Meta.</p><p>For Facebook Lead Forms, we also store the selected Page, form identifiers and questions, the authorizing Facebook user ID, encrypted Page credentials, and submitted lead answers such as names, emails and phone numbers. The company owner selects which forms to sync. We retrieve existing submissions and new submissions notified by Meta webhooks, and display them to the owning account. The Lead Forms feature does not create advertising campaigns or automatically contact these leads.</p><p>For Facebook Page posts, the owner authorizes a managed Page. We store its identifier and name, authorizing Facebook user and app identifiers, encrypted Page credentials, imported feed posts and customer comments with available author details and timestamps, and publishing action results. We use this data to display community content and publish, edit or delete the owner's app-created Page posts only following their explicit actions. Disconnect clears this feature's credentials; deleting the stored integration erases its local content and history. Posts already published on Facebook remain until the owner explicitly deletes them.</p><p>For Business &amp; Ads, the visitor authorizes a Facebook user token. We store the authorizing user ID, granted permissions, encrypted credentials and local campaign creation records. We read authorized business portfolios, owned/client ad accounts, campaign details and advertising performance metrics for the selected reporting period. A visitor can explicitly create a paused traffic campaign in their selected ad account. This feature creates no ad sets, ads or budgets. Disconnect deletes its stored authorization and local action records. Campaigns created on Meta remain in the ad account and can be managed there. Signed Facebook revocation and data-deletion requests remove the associated local authorization and action records.</p><p>For Instagram, the owner connects a professional account directly through Instagram Login or through an optional linked Facebook Page. We store its account identifier and username, login provider and app identifier, authorizing Instagram or Facebook user identifier, encrypted credentials, customer conversation identifiers and message text/timestamps, and imported posts and comments. Linked Page details are stored only for Facebook connections. We use this data to display customer messages, send manual replies within the 24-hour customer messaging window, and publish comment replies or hide/unhide comments on the connected account's own posts. Signed webhooks update incoming messages and comments. With publishing permission, owners upload JPEG photos or MP4 Reels or provide a media URL, write a caption, prepare the media and explicitly publish to their connected Instagram account. We store captions, publication status and published media identifiers. Uploaded files are shared with Meta through unpredictable links that expire after 24 hours; expired and orphaned files older than 48 hours are removed during subsequent upload activity. Deleting the integration immediately invalidates its upload links.</p><p>Data is shared with Meta to provide business ad account selection, ad reporting, paused campaign creation, Messenger and Instagram replies, comment moderation and post publishing and with the business operating the connected Page. Access is limited to the owning account and its authorized team. Tokens are stored encrypted and are never displayed in the dashboard.</p><p>Disconnect removes stored credentials and stops processing new events for that integration. Shared Page subscriptions may remain for other connected features. Conversation history is retained until the business deletes the integration. Deauthorizing in Facebook or Instagram removes credentials for that login provider; a verified data-deletion request removes the stored integration data linked to the requesting authorization. Businesses can also choose Delete stored integration in Settings. Contact us to request customer-message deletion; identify the Page and conversation without sending passwords or tokens.</p><p>This notice covers the Messenger, Lead Forms, Page posts, Business &amp; Ads and Instagram integrations. The business's own privacy notice and the SaaS's broader privacy policy also apply. The deployment operator is responsible for describing hosting providers, backup retention and any additional processing in its main policy.</p><p><a href="/v1/facebook/data-deletion">Data deletion instructions</a></p></main></html>`,
      );
  });
  deletionInstructions = facebookHandler(async (_req, res) => {
    const email = process.env.FACEBOOK_PRIVACY_EMAIL;
    if (!email) throw new FacebookError(503, 'The privacy contact must be configured.');
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Facebook data deletion instructions</title><h1>Delete Facebook integration data</h1><p>Log into this application and open Settings → Integrations → Facebook Messenger. Choose Delete stored integration on the Page card. This disconnects the Page and deletes its stored credentials, conversations and messages from the active database.</p><p>For Facebook Lead Forms, open the Lead Forms workspace at /v1/facebook/leads and choose Delete stored integration on the Page card to erase its forms and submitted leads. Disconnect stops lead syncing and removes credentials while retaining stored leads.</p><p>For Page posts, open /v1/facebook/posts and choose Delete stored integration to erase its saved connection, imported posts/comments and local publishing history. This does not remove posts from Facebook. To delete an app-created Facebook post, open its Page and explicitly choose Delete post.</p><p>For Instagram, open /v1/facebook/instagram and choose Delete stored integration to erase its account, messages, posts, comments, publication records and upload links. Temporary files are cleaned during subsequent upload activity. Disconnect removes credentials while retaining history.</p><p>For Business &amp; Ads, open /v1/facebook/ads in the browser you connected and choose Disconnect &amp; delete stored connection. This removes its encrypted credentials, pending logins and local campaign creation records. Campaigns already created on Meta remain in the ad account; manage them in Meta Ads Manager.</p><p>You can also remove the app through Facebook Business Integrations or Instagram Apps and Websites and request deletion through the corresponding platform. We verify its signed request, delete data linked to that authorization and return a confirmation URL.</p><p>For customer-message or lead-data deletion or assistance contact ${escape(email)} with the Page and conversation details. Do not send passwords or tokens. Ask the operator about its backup retention policy.</p></html>`,
      );
  });
}
export default new FacebookMessengerController();
