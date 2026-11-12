import { Request, Response, NextFunction } from 'express';
import { verifySignature } from '../../utils/facebook';
import { WabaOnboardingError, safeOnboardingError, metaTokenAppConfig } from '../../utils/wabaOnboarding';
import onboarding from '../../services/wabaOnboarding.service';

export async function wabaAccountUpdate(req: Request, _res: Response, next: NextFunction) {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const hasUpdate = entries.some((entry: any) => Array.isArray(entry.changes) && entry.changes.some((change: any) => change.field === 'account_update'));
    if (!hasUpdate) return next();
    const secret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    let valid = Boolean(raw && secret && verifySignature(raw, req.headers['x-hub-signature-256'], secret));
    if (!valid && raw && process.env.META_NEW_APP_ACCESS_TOKEN) {
      const secondarySecret = metaTokenAppConfig(process.env.META_NEW_APP_ACCESS_TOKEN).appSecret;
      valid = Boolean(secondarySecret && verifySignature(raw, req.headers['x-hub-signature-256'], secondarySecret));
    }
    if (!valid) throw new WabaOnboardingError(
      'WABA_WEBHOOK_SIGNATURE_INVALID', 'Invalid Meta account-update signature.', false, 403);
    await onboarding.receiveAccountUpdates(req.body);
    next();
  } catch (error) { next(safeOnboardingError(error)); }
}
