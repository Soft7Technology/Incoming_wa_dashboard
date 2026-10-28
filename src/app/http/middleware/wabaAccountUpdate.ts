import { Request, Response, NextFunction } from 'express';
import { verifySignature } from '../../utils/facebook';
import { WabaOnboardingError, safeOnboardingError } from '../../utils/wabaOnboarding';
import onboarding from '../../services/wabaOnboarding.service';

export async function wabaAccountUpdate(req: Request, _res: Response, next: NextFunction) {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const hasUpdate = entries.some((entry: any) => Array.isArray(entry.changes) && entry.changes.some((change: any) => change.field === 'account_update'));
    if (!hasUpdate) return next();
    const secret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
    if (!secret) throw new WabaOnboardingError('WABA_WEBHOOK_CONFIGURATION_REQUIRED', 'Configure the Meta app secret before accepting account updates.', false, 503);
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw || !verifySignature(raw, req.headers['x-hub-signature-256'], secret)) throw new WabaOnboardingError(
      'WABA_WEBHOOK_SIGNATURE_INVALID', 'Invalid Meta account-update signature.', false, 403);
    await onboarding.receiveAccountUpdates(req.body);
    next();
  } catch (error) { next(safeOnboardingError(error)); }
}
