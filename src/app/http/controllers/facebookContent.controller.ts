import { Request } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import service, { contentConfig, contentPermissions } from '../../services/facebookContent.service';
import { FacebookError } from '../../utils/facebook';
import { facebookHandler } from './facebookMessenger.controller';

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
    .find((v) => v.startsWith('fb_content_browser='))
    ?.slice(19);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
};
class FacebookContentController {
  setup = facebookHandler(async (req, res) => {
    await service.access(scope(req));
    let issue: string | null = null,
      tokenIssue: string | null = null;
    try {
      contentConfig();
    } catch (e) {
      issue = e instanceof FacebookError ? e.message : 'Facebook posts login is not configured.';
    }
    try {
      contentConfig(false);
    } catch (e) {
      tokenIssue = e instanceof FacebookError ? e.message : 'Facebook is not configured.';
    }
    res.json({
      success: true,
      data: {
        ready: !issue,
        issue,
        token_ready: !tokenIssue,
        token_issue: tokenIssue,
        permissions: contentPermissions,
      },
    });
  });
  start = facebookHandler(async (req, res) => {
    const result = await service.start(scope(req));
    this.cookie(res, result.browser);
    res.json({ success: true, data: { authorization_url: result.url } });
  });
  private cookie(res: any, value: string) {
    res.cookie('fb_content_browser', value, {
      httpOnly: true,
      secure: contentConfig(false).secure,
      sameSite: 'lax',
      path: '/v1',
      maxAge: 900000,
    });
  }
  importToken = facebookHandler(async (req, res) => {
    const input = req.body?.access_token;
    if (req.body) delete req.body.access_token;
    const result = await service.importToken(scope(req), input);
    this.cookie(res, result.browser);
    res.json({ success: true, data: { status: 'ready' } });
  });
  callback = facebookHandler(async (req, res) => {
    const status = await service.callback(req.query.state, browser(req), req.query.code, Boolean(req.query.error));
    res.redirect(303, `/v1/facebook/posts#oauth=${status}`);
  });
  candidates = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.candidates(scope(req), browser(req)) }),
  );
  connect = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.connect(scope(req), browser(req), req.body?.page_id) }),
  );
  pages = facebookHandler(async (req, res) => res.json({ success: true, data: await service.pages(scope(req)) }));
  posts = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.posts(scope(req), req.params.id) }),
  );
  comments = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.comments(scope(req), req.params.id, req.params.post) }),
  );
  sync = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.sync(scope(req), req.params.id, req.params.post, req.body?.after) }),
  );
  actions = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.actions(scope(req), req.params.id) }),
  );
  action = (kind: 'create' | 'edit' | 'delete') =>
    facebookHandler(async (req, res) =>
      res.json({
        success: true,
        data: await service.action(scope(req), req.params.id, kind, req.body, req.params.post),
      }),
    );
  disconnect = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.disconnect(scope(req), req.params.id) }),
  );
  erase = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.disconnect(scope(req), req.params.id, true) }),
  );
}
export default new FacebookContentController();
