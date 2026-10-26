import { Request } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import service, { adsConfig, adsPermissions } from '../../services/facebookAds.service';
import { config, FacebookError } from '../../utils/facebook';
import { facebookHandler } from './facebookMessenger.controller';

const scope = (req: JWTAuthRequest) => ({ companyId: req.companyId!, ownerId: (req.ownerId || req.userId)!,
  userId: req.userId!, reviewPageId: req.facebookReviewPageId });
const browser = (req: Request) => req.headers.cookie?.split(';').map(p => p.trim())
  .find(p => p.startsWith('fb_ads_browser='))?.slice('fb_ads_browser='.length);

class FacebookAdsController {
  setup = facebookHandler(async (req, res) => {
    await service.access(scope(req));
    let issue: string | null = null;
    try { adsConfig(); } catch (error) { issue = error instanceof FacebookError ? error.message : 'Invalid Facebook configuration.'; }
    res.json({ success: true, data: { ready: !issue, issue, permissions: adsPermissions } });
  });
  status = facebookHandler(async (req, res) => res.json({ success: true, data: await service.status(scope(req), browser(req)) }));
  start = facebookHandler(async (req, res) => {
    const result = await service.start(scope(req));
    res.cookie('fb_ads_browser', result.browser, { httpOnly: true, secure: config('transport').secure,
      sameSite: 'lax', path: '/v1/facebook', maxAge: 15 * 60 * 1000 });
    res.json({ success: true, data: { authorization_url: result.url } });
  });
  callback = facebookHandler(async (req, res) => {
    const result = await service.callback(req.query.state, browser(req), req.query.code, Boolean(req.query.error));
    res.redirect(303, `/v1/facebook/ads#oauth=${result}`);
  });
  businesses = facebookHandler(async (req, res) => res.json({ success: true, data: await service.businesses(scope(req)) }));
  accounts = facebookHandler(async (req, res) => res.json({ success: true, data: await service.accounts(scope(req), req.params.business) }));
  campaigns = facebookHandler(async (req, res) => res.json({ success: true,
    data: await service.campaigns(scope(req), req.params.business, req.params.account) }));
  insights = facebookHandler(async (req, res) => res.json({ success: true,
    data: await service.insights(scope(req), req.params.business, req.params.account, req.query.period || 'last_30d') }));
  create = facebookHandler(async (req, res) => res.json({ success: true,
    data: await service.create(scope(req), req.params.business, req.params.account, req.body) }));
  disconnect = facebookHandler(async (req, res) => res.json({ success: true, data: await service.disconnect(scope(req)) }));
}
export default new FacebookAdsController();
