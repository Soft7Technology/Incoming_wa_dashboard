import crypto from 'crypto';
import { CustomError } from '@surefy/exceptions/CustomError';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export class WabaOnboardingError extends CustomError {
  constructor(public code: string, message: string, public retryable = false, status = 400) {
    super(message, status, true, { code, retryable });
  }
}
export interface WabaScope { userId: string; companyId: string }
export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function metaId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,255}$/.test(value)) throw new HTTP400Error({ message: `${field} must be a Meta ID string or null.` });
  return value;
}
export function encryptionKey() {
  const key = Buffer.from(process.env.WABA_TOKEN_ENCRYPTION_KEY || process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new WabaOnboardingError('WABA_CONFIGURATION_REQUIRED', 'Configure WABA_TOKEN_ENCRYPTION_KEY as a stable base64-encoded 32-byte key.', false, 503);
  return key;
}
export function wabaConfig() {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
  const version = process.env.META_API_VERSION;
  if (!appId || !appSecret || !version || !/^v\d+\.\d+$/.test(version)) throw new WabaOnboardingError(
    'WABA_CONFIGURATION_REQUIRED', 'Configure the Embedded Signup Meta app ID, app secret, and an active META_API_VERSION.', false, 503);
  encryptionKey();
  return { appId, appSecret, version };
}
function context(scope: WabaScope, id: string) { return Buffer.from(`waba:${scope.companyId}:${scope.userId}:${id}`); }
export function sealToken(token: string, scope: WabaScope, id: string) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(context(scope, id));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['wa1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
export function openToken(encrypted: string, scope: WabaScope, id: string) {
  try {
    const [version, iv, tag, value] = encrypted.split('.');
    if (version !== 'wa1' || !iv || !tag || !value) throw new Error();
    const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    cipher.setAAD(context(scope, id)); cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(value, 'base64')), cipher.final()]).toString('utf8');
  } catch { throw new WabaOnboardingError('WABA_CREDENTIAL_UNAVAILABLE', 'Cannot read saved WhatsApp authorization. Check the encryption key or reconnect through Embedded Signup.', false, 503); }
}
export function safeOnboardingError(error: any): WabaOnboardingError {
  if ((typeof error?.code === 'string' && error.code.startsWith('WABA_')) ||
      ['META_PERMISSION_REQUIRED',
        'META_TEMPORARILY_UNAVAILABLE', 'SIGNUP_SELECTION_REQUIRED', 'SIGNUP_NO_AUTHORIZED_WABA', 'SIGNUP_TOKEN_INVALID',
        'SIGNUP_PHONE_NOT_IN_WABA', 'SIGNUP_IDEMPOTENCY_CONFLICT', 'SIGNUP_STATE_INVALID', 'SIGNUP_AUTHORIZATION_USED',
        'SIGNUP_LEASE_LOST', 'SIGNUP_RETRY_EXHAUSTED'].includes(error?.code)) return error;
  if (error?.isOperational && error.statusCode === 400) return new WabaOnboardingError('WABA_BAD_REQUEST', error.message);
  if (error?.isOperational && [403, 404, 409].includes(error.statusCode)) return new WabaOnboardingError(
    'WABA_ACCOUNT_CONFLICT', 'The selected account or phone conflicts with an existing connection. Check account ownership and the selected WABA before retrying.', false, 409);
  return new WabaOnboardingError('WABA_SETUP_UNAVAILABLE', 'WhatsApp setup could not be saved or confirmed. Check onboarding status before reconnecting.', true, 503);
}
