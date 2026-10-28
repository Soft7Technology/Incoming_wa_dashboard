import { Request } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import service from '../../services/facebookLeads.service';
import { config, FacebookError, leadPermissions } from '../../utils/facebook';
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
    .map((p) => p.trim())
    .find((p) => p.startsWith('fb_lead_browser='))
    ?.slice(16);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
};

class FacebookLeadsController {
  setup = facebookHandler(async (req, res) => {
    await service.access(scope(req));
    let issue: string | null = null;
    let tokenIssue: string | null = null;
    try {
      config('leads');
    } catch (e) {
      issue = e instanceof FacebookError ? e.message : 'Invalid Facebook configuration.';
    }
    try {
      config('transport');
    } catch (e) {
      tokenIssue = e instanceof FacebookError ? e.message : 'Invalid Facebook configuration.';
    }
    res.json({
      success: true,
      data: {
        ready: !issue,
        issue,
        token_ready: !tokenIssue,
        token_issue: tokenIssue,
        preset_ready: !tokenIssue && service.presetAvailable(scope(req)),
        preset_page_name: service.presetAvailable(scope(req))
          ? process.env.FACEBOOK_LEADS_PRESET_PAGE_NAME || 'test Page'
          : null,
        preset_page_id: service.presetAvailable(scope(req)) ? process.env.FACEBOOK_LEADS_PRESET_PAGE_ID : null,
        permissions: leadPermissions,
        subscriptions: ['leadgen'],
      },
    });
  });
  connectPreset = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.connectPreset(scope(req)) }),
  );
  choosePresetPages = facebookHandler(async (req, res) => {
    const result = await service.choosePresetPages(scope(req));
    res.cookie('fb_lead_browser', result.browser, {
      httpOnly: true,
      secure: config('transport').secure,
      sameSite: 'lax',
      path: '/v1',
      maxAge: 15 * 60 * 1000,
    });
    res.json({ success: true, data: { status: 'ready' } });
  });
  importToken = facebookHandler(async (req, res) => {
    const input = req.body?.access_token;
    if (req.body) delete req.body.access_token;
    const result = await service.importToken(scope(req), input);
    res.cookie('fb_lead_browser', result.browser, {
      httpOnly: true,
      secure: config('transport').secure,
      sameSite: 'lax',
      path: '/v1',
      maxAge: 15 * 60 * 1000,
    });
    res.json({ success: true, data: { status: 'ready' } });
  });
  start = facebookHandler(async (req, res) => {
    const result = await service.start(scope(req));
    res.cookie('fb_lead_browser', result.browser, {
      httpOnly: true,
      secure: config('leads').secure,
      sameSite: 'lax',
      path: '/v1',
      maxAge: 15 * 60 * 1000,
    });
    res.json({ success: true, data: { authorization_url: result.url } });
  });
  callback = facebookHandler(async (req, res) => {
    const result = await service.callback(req.query.state, browser(req), req.query.code, Boolean(req.query.error));
    res.redirect(303, `/v1/facebook/leads#oauth=${result}`);
  });
  candidates = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.candidates(scope(req), browser(req)) }),
  );
  connect = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.connect(scope(req), browser(req), req.body?.page_id) }),
  );
  pages = facebookHandler(async (req, res) => res.json({ success: true, data: await service.pages(scope(req)) }));
  forms = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.forms(scope(req), req.params.id, req.query.after) }),
  );
  enable = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.enable(scope(req), req.params.id, req.body?.enabled) }),
  );
  sync = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.sync(scope(req), req.params.id, req.body?.after) }),
  );
  leads = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.leads(scope(req), req.params.id, req.query.before) }),
  );
  disconnect = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.disconnect(scope(req), req.params.id) }),
  );
  erase = facebookHandler(async (req, res) =>
    res.json({ success: true, data: await service.disconnect(scope(req), req.params.id, true) }),
  );
}
export default new FacebookLeadsController();
