import { Request, Response, NextFunction } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync } from '@surefy/utils/Controller';
import service from '../../services/googlePeople.service';
import { configuration } from '../../utils/googlePeople';

const scope = (req: JWTAuthRequest) => ({
  companyId: req.companyId!,
  ownerId: (req.ownerId ?? req.userId)!,
  userId: req.userId!,
});
export const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
  next();
};
class GooglePeopleController {
  publicSetup = tryCatchAsync(async (_req: Request, res: Response) => {
    const c = configuration();
    res.json({
      success: true,
      data: {
        redirect_uri: c.redirectUri,
        login_domain:
          process.env.GOOGLE_TEST_LOGIN_DOMAIN || (process.env.NODE_ENV !== 'production' ? 'localhost' : ''),
      },
    });
  });
  setup = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.setup(scope(req)) }),
  );
  saveApp = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.saveApp(scope(req), req.body) }),
  );
  removeApp = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.removeApp(scope(req)) }),
  );
  start = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await service.start(scope(req)),
      secure = configuration().secure;
    res.cookie('google_people_browser', result.browser, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/v1/integrations/google-people',
      maxAge: 600000,
    });
    res.json({ success: true, data: { authorization_url: result.authorization_url } });
  });
  callback = tryCatchAsync(async (req: Request, res: Response) => {
    const browser = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('google_people_browser='))
      ?.slice('google_people_browser='.length);
    const result = await service.callback(req.query.state, browser, req.query.code, req.query.error !== undefined);
    const secure = configuration().secure;
    res.clearCookie('google_people_browser', {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/v1/integrations/google-people',
    });
    res.redirect(303, `/v1/integrations/google-people/app?connected=${result.connected ? '1' : '0'}`);
  });
  connection = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.connection(scope(req)) }),
  );
  disconnect = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.disconnect(scope(req)) }),
  );
  list = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.list(scope(req), req.query) }),
  );
  get = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.get(scope(req), req.params.personId) }),
  );
  create = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.status(201).json({ success: true, data: await service.createContact(scope(req), req.body) }),
  );
  update = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.updateContact(scope(req), req.params.personId, req.body) }),
  );
}
export default new GooglePeopleController();
