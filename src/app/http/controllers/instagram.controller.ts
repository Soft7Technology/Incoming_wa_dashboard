import { frontendCallback } from '../../utils/facebook';
import { Request } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import service, { instagramConfig, instagramPermissions } from '../../services/instagram.service';
import { FacebookError, publicOrigin, signedUser, verifySignature } from '../../utils/facebook';
import { directInstagramLoginScopes } from '../../services/instagramGraph.service';
import publishing from '../../services/instagramPublishing.service';
import { receivePublishingMedia } from '../../utils/instagramPublishingMedia';
import { metaHandler } from './metaHttp.controller';
import { requireDashboardOrigin } from '../../services/dashboardOrigin.service';

const scope = (req: JWTAuthRequest) => ({
  companyId: req.companyId!,
  ownerId: (req.ownerId || req.userId)!,
  userId: req.userId!,
  reviewPageId: req.facebookReviewPageId,
});
const browser = (req: Request) => {
  const value = req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('ig_browser='))
    ?.slice(11);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
};
class InstagramController {
  setup = metaHandler(async (req, res) => {
    await service.access(scope(req));
    if (req.headers.origin) await requireDashboardOrigin(req.headers.origin, req.companyId!);
    const providers = ['instagram', 'facebook'].map((provider) => {
      try {
        instagramConfig(provider);
        return { provider, ready: true, issue: null };
      } catch (e) {
        return {
          provider,
          ready: false,
          issue: e instanceof FacebookError ? e.message : 'Instagram configuration is incomplete.',
        };
      }
    });
    const selected = providers.find((p) => p.provider === (process.env.INSTAGRAM_AUTH_PROVIDER || 'instagram'))!;
    const { base } = publicOrigin(
      process.env.INSTAGRAM_PUBLIC_URL || process.env.FACEBOOK_PUBLIC_URL,
      'INSTAGRAM_PUBLIC_URL',
    );
    res.json({
      success: true,
      data: {
        ready: selected?.ready || false,
        issue: selected?.issue || null,
        providers,
        permissions: selected?.provider === 'facebook' ? instagramPermissions : directInstagramLoginScopes,
        callback: `${base}/v1/facebook/instagram/oauth/callback`,
        webhook_callback: `${base}/v1/facebook/instagram/webhook`,
        webhook_fields: ['messages', 'comments'],
      },
    });
  });
  start = metaHandler(async (req, res) => {
    const provider = req.body?.provider;
    if (provider !== undefined && provider !== 'instagram' && provider !== 'facebook')
      throw new FacebookError(400, 'Choose Instagram or Facebook login.');
    const result = await service.start(scope(req), provider, req.headers.origin);
    res.cookie('ig_browser', result.browser, {
      httpOnly: true,
      secure: instagramConfig(provider).secure,
      sameSite: instagramConfig(provider).secure ? 'none' : 'lax',
      path: '/v1',
      maxAge: 15 * 60000,
    });
    res.json({ success: true, data: { authorization_url: result.url } });
  });
  callback = metaHandler(async (req, res) => {
    const result = await service.callback(req.query.state, browser(req), req.query.code, Boolean(req.query.error));
    res.redirect(303, frontendCallback(result.frontendOrigin, 'instagram', result.status));
  });
  candidates = metaHandler(async (req, res) =>
    res.json({ success: true, data: await service.candidates(scope(req), browser(req)) }),
  );
  connect = metaHandler(async (req, res) =>
    res.json({
      success: true,
      data: await service.connect(scope(req), browser(req), req.body?.instagram_id || req.body?.page_id),
    }),
  );
  verify = metaHandler(async (req, res) => {
    const expected = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN;
    if (!expected) throw new FacebookError(503, 'Instagram webhook verification is not configured.');
    if (
      req.query['hub.mode'] !== 'subscribe' ||
      req.query['hub.verify_token'] !== expected ||
      typeof req.query['hub.challenge'] !== 'string'
    )
      throw new FacebookError(403, 'Instagram webhook verification failed.');
    res.type('text/plain').send(req.query['hub.challenge']);
  });
  receive = metaHandler(async (req, res) => {
    const secret = process.env.INSTAGRAM_APP_SECRET;
    if (!secret) throw new FacebookError(503, 'Instagram webhook signing is not configured.');
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw || !verifySignature(raw, req.headers['x-hub-signature-256'], secret))
      throw new FacebookError(403, 'Invalid Instagram webhook signature.');
    await service.receive(req.body, 'instagram');
    res.type('text/plain').send('EVENT_RECEIVED');
  });
  deauthorize = metaHandler(async (req, res) => {
    if (!process.env.INSTAGRAM_APP_SECRET) throw new FacebookError(503, 'Instagram is not configured.');
    await service.revoke(signedUser(req.body?.signed_request, process.env.INSTAGRAM_APP_SECRET), false, 'instagram');
    res.json({ success: true, data: { deauthorized: true } });
  });
  deletion = metaHandler(async (req, res) => {
    if (!process.env.INSTAGRAM_APP_SECRET) throw new FacebookError(503, 'Instagram is not configured.');
    const user = signedUser(req.body?.signed_request, process.env.INSTAGRAM_APP_SECRET);
    const confirmation = await service.revoke(user, true, 'instagram');
    const { base } = publicOrigin(
      process.env.INSTAGRAM_PUBLIC_URL || process.env.FACEBOOK_PUBLIC_URL,
      'INSTAGRAM_PUBLIC_URL',
    );
    res.json({ url: `${base}/v1/facebook/data-deletion/status/${confirmation}`, confirmation_code: confirmation });
  });
  deletionStatus = metaHandler(async (req, res) => {
    const confirmation = req.params.confirmation;
    if (!/^[A-Za-z0-9_-]{43}$/.test(confirmation)) throw new FacebookError(404, 'Deletion confirmation was not found.');
    const request = await service.deletionStatus(confirmation);
    if (!request) throw new FacebookError(404, 'Deletion confirmation was not found.');
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Instagram data deletion</title><h1>Instagram data deletion completed</h1><p>Completed: ${new Date(request.completed_at).toISOString()}</p></html>`,
      );
  });
  accounts = metaHandler(async (req, res) => res.json({ success: true, data: await service.accounts(scope(req)) }));
  syncProfile = metaHandler(async (req, res) =>
    res.json({ success: true, data: await service.syncProfile(scope(req), req.params.id) }),
  );
  publishingSettings = metaHandler(async (req, res) =>
    res.json({ success: true, data: await publishing.settings(scope(req), req.params.id) }),
  );
  publications = metaHandler(async (req, res) =>
    res.json({ success: true, data: await publishing.list(scope(req), req.params.id) }),
  );
  preparePost = metaHandler(async (req, res) =>
    res.json({ success: true, data: await publishing.create(scope(req), req.params.id, req.body) }),
  );
  publicationStatus = metaHandler(async (req, res) =>
    res.json({ success: true, data: await publishing.refresh(scope(req), req.params.id, req.params.publication) }),
  );
  publishPost = metaHandler(async (req, res) =>
    res.json({ success: true, data: await publishing.publish(scope(req), req.params.id, req.params.publication) }),
  );
  uploadPublishingMedia = metaHandler(async (req, res) => {
    await publishing.authorize(scope(req), req.params.id);
    await new Promise<void>((resolve, reject) =>
      receivePublishingMedia(req, res, (error: any) => {
        if (!error) return resolve();
        reject(
          error instanceof FacebookError
            ? error
            : new FacebookError(
                error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
                'Choose one JPEG photo up to 8 MB or MP4 Reel up to 100 MB.',
              ),
        );
      }),
    );
    res.json({ success: true, data: await publishing.saveAsset(scope(req), req.params.id, req.file) });
  });
  publishingMedia = metaHandler(async (req, res) => {
    const asset = await publishing.publicAsset(req.params.token);
    res.type(asset.type).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store');
    await new Promise<void>((resolve, reject) =>
      res.sendFile(asset.path, { dotfiles: 'allow', cacheControl: false }, (error) =>
        error ? reject(new FacebookError(404, 'Media expired or was removed.')) : resolve(),
      ),
    );
  });
  list = (kind: 'conversation' | 'media') =>
    metaHandler(async (req, res) =>
      res.json({ success: true, data: await service.list(scope(req), req.params.id, kind) }),
    );
  sync = (kind: 'conversation' | 'media' | 'message' | 'comment') =>
    metaHandler(async (req, res) =>
      res.json({
        success: true,
        data: await service.sync(scope(req), req.params.id, kind, req.params.child, req.body?.after),
      }),
    );
  messages = metaHandler(async (req, res) =>
    res.json({ success: true, data: await service.messages(scope(req), req.params.id, req.params.child) }),
  );
  comments = metaHandler(async (req, res) =>
    res.json({ success: true, data: await service.comments(scope(req), req.params.id, req.params.child) }),
  );
  action = (type: 'message' | 'reply' | 'hide') =>
    metaHandler(async (req, res) =>
      res.json({
        success: true,
        data: await service.action(
          scope(req),
          req.params.id,
          req.params.child,
          type,
          type === 'hide' ? req.body?.hidden : req.body?.text,
          req.body?.client_request_id,
        ),
      }),
    );
  disconnect = metaHandler(async (req, res) =>
    res.json({ success: true, data: await service.disconnect(scope(req), req.params.id) }),
  );
  erase = metaHandler(async (req, res) =>
    res.json({ success: true, data: await service.disconnect(scope(req), req.params.id, true) }),
  );
}
export default new InstagramController();
