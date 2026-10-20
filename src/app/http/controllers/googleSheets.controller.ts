import { Request, Response, NextFunction } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync } from '@surefy/utils/Controller';
import service from '../../services/googleSheets.service';
import { configuration, googleFileScope } from '../../utils/googleSheets';

const scope = (req: JWTAuthRequest) => ({
  companyId: req.companyId!,
  ownerId: (req.ownerId ?? req.userId)!,
  userId: req.userId!,
});
export const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
  next();
};
const browser = (req: Request) =>
  req.headers.cookie
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('google_sheet_browser='))
    ?.slice('google_sheet_browser='.length);

class GoogleSheetsController {
  testConfig = tryCatchAsync(async (_req: Request, res: Response) => {
    let issue: string | null = null;
    try {
      configuration();
    } catch (e) {
      issue = e instanceof Error ? e.message : 'Invalid Google configuration.';
    }
    let testUrl: string | null = null;
    let loginDomain = '';
    try {
      testUrl = new URL('/v1/integrations/google/test', process.env.GOOGLE_REDIRECT_URI).toString();
    } catch {}
    try {
      loginDomain = new URL(process.env.GOOGLE_FRONTEND_URL || '').hostname;
    } catch {}
    if (process.env.GOOGLE_TEST_LOGIN_DOMAIN) loginDomain = process.env.GOOGLE_TEST_LOGIN_DOMAIN;
    else if (process.env.NODE_ENV !== 'production') loginDomain = 'localhost';
    res.json({
      success: true,
      data: {
        ready: !issue,
        issue,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || null,
        test_url: testUrl,
        login_domain: loginDomain,
      },
    });
  });
  setup = tryCatchAsync(async (_req: JWTAuthRequest, res: Response) => {
    let issue: string | null = null;
    try {
      configuration();
    } catch (e) {
      issue = e instanceof Error ? e.message : 'Invalid Google configuration.';
    }
    res.json({
      success: true,
      data: {
        ready: !issue,
        issue,
        scope: googleFileScope,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || null,
        max_rows: 10000,
        max_columns: 100,
        selection: 'Use Google Picker with drive.file permission before previewing a spreadsheet.',
        picker: {
          ready: Boolean(
            process.env.GOOGLE_PICKER_API_KEY?.trim() &&
            /^\d{6,20}$/.test(process.env.GOOGLE_CLOUD_PROJECT_NUMBER || ''),
          ),
          api_key: process.env.GOOGLE_PICKER_API_KEY?.trim() || null,
          app_id: process.env.GOOGLE_CLOUD_PROJECT_NUMBER || null,
        },
      },
    });
  });
  start = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await service.start(scope(req));
    const secure = configuration().secure;
    res.cookie('google_sheet_browser', result.browser, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/v1/integrations/google',
      maxAge: 10 * 60 * 1000,
    });
    res.json({ success: true, data: { authorization_url: result.authorization_url } });
  });
  callback = tryCatchAsync(async (req: Request, res: Response) => {
    // No third-party content or frontend redirect receives the OAuth callback URL.
    res.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const result = await service.callback(req.query.state, browser(req), req.query.code, Boolean(req.query.error));
    const secure = configuration().secure;
    res.clearCookie('google_sheet_browser', {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/v1/integrations/google',
    });
    res.json({
      success: true,
      message: result.connected ? 'Google connected. Return to your dashboard.' : 'Google connection was cancelled.',
      data: result,
    });
  });
  connection = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.connection(scope(req)) }),
  );
  disconnect = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.disconnect(scope(req)) }),
  );
  pickerToken = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.pickerToken(scope(req)) }),
  );
  spreadsheets = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.spreadsheets(scope(req), req.query.page_token) }),
  );
  tabs = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.tabs(scope(req), req.params.id) }),
  );
  sample = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.sample(scope(req), req.params.id, req.params.sheetId) }),
  );
  preview = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.status(201).json({ success: true, data: await service.preview(scope(req), req.body) }),
  );
  snapshots = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.snapshots(scope(req)) }),
  );
  importSnapshot = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.status(202).json({ success: true, data: await service.importSnapshot(scope(req), req.params.id, req.body) }),
  );
  importStatus = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.importStatus(scope(req), req.params.id) }),
  );
  campaign = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await service.createCampaign(scope(req), req.body);
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  });
  bulkCampaigns = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await service.bulkCampaigns(scope(req), req.body);
    res.status(result.failed ? 207 : 200).json({ success: !result.failed, data: result });
  });
}
export default new GoogleSheetsController();
