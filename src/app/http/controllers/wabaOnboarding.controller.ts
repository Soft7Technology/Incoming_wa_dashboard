import { Request, Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import service from '../../services/wabaOnboarding.service';
import { safeOnboardingError } from '../../utils/wabaOnboarding';

const scope = (req: JWTAuthRequest) => ({ userId: req.ownerId ?? req.userId!, companyId: req.companyId! });
const handle = (fn: (req: JWTAuthRequest, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try { await fn(req as JWTAuthRequest, res); }
  catch (error) {
    const safe = safeOnboardingError(error);
    res.status(safe.statusCode).json({ success: false, message: safe.message, error: { code: safe.code, retryable: safe.retryable } });
  }
};
function reply(res: Response, result: any, statusRead = false) {
  if (result.connected) return res.status(200).json({ success: true, message: 'WhatsApp account connected', data: result.data });
  if (result.httpStatus >= 400 && !statusRead) return res.status(result.httpStatus).json({ success: false,
    message: result.data.error?.message || 'WhatsApp setup requires action',
    error: { code: result.data.error?.code || 'WABA_SETUP_REQUIRED', retryable: result.data.error?.retryable ?? false,
      onboarding_id: result.data.onboarding_id }, data: result.data });
  return res.status(statusRead ? 200 : result.httpStatus).json({ success: true,
    message: result.data.status === 'pending' ? 'WhatsApp setup is pending' : 'WhatsApp setup requires a selection or action', data: result.data });
}
export default {
  status: handle(async (req, res) => reply(res, await service.status(scope(req), req.params.onboardingId), true)),
  retry: handle(async (req, res) => reply(res, await service.retry(scope(req), req.params.onboardingId, req.body))),
};
