import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { CustomError } from '@surefy/exceptions/CustomError';

export interface PeopleScope {
  companyId: string;
  ownerId: string;
  userId: string;
}
export interface PeopleOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  source: 'custom' | 'shared';
}
export const contactsScope = 'https://www.googleapis.com/auth/contacts';
export const personFields = 'metadata,names,emailAddresses,phoneNumbers';
export const contactFields = ['names', 'emailAddresses', 'phoneNumbers'] as const;
export const fail = (status: number, message: string): never => {
  throw new CustomError(message, status);
};
export const random = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const nonce = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function owner(scope: PeopleScope) {
  if (!scope.companyId || !scope.userId || scope.userId !== scope.ownerId)
    fail(403, 'Only the account owner can manage Google Contacts.');
}
function key() {
  const value = Buffer.from(
    process.env.GOOGLE_PEOPLE_TOKEN_ENCRYPTION_KEY || process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '',
    'base64',
  );
  if (value.length !== 32) fail(503, 'Configure a stable 32-byte base64 Google People encryption key.');
  return value;
}
export function encrypt(value: string, scope: PeopleScope) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(`google-people:${scope.companyId}:${scope.ownerId}`));
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((v) => v.toString('base64')).join('.');
}
export function decrypt(value: string, scope: PeopleScope) {
  try {
    const [iv, tag, bytes] = value.split('.').map((v) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(`google-people:${scope.companyId}:${scope.ownerId}`));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
  } catch {
    return fail(503, 'Saved Google Contacts credentials cannot be decrypted. Check the original encryption key.');
  }
}
export function configuration() {
  let url: URL;
  try {
    url = process.env.GOOGLE_PEOPLE_REDIRECT_URI
      ? new URL(process.env.GOOGLE_PEOPLE_REDIRECT_URI)
      : new URL('/v1/integrations/google-people/callback', process.env.GOOGLE_REDIRECT_URI);
  } catch {
    return fail(503, 'Set GOOGLE_PEOPLE_REDIRECT_URI to your Google People callback URL.');
  }
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/integrations/google-people/callback'
  )
    fail(503, 'Use an HTTPS /v1/integrations/google-people/callback URL (localhost HTTP is allowed).');
  key();
  return { redirectUri: url.toString(), origin: url.origin, secure: url.protocol === 'https:' };
}
export function credentials(clientId: unknown, clientSecret: unknown) {
  if (
    typeof clientId !== 'string' ||
    !clientId.trim() ||
    clientId.length > 500 ||
    /[\s\x00-\x1f]/.test(clientId.trim()) ||
    typeof clientSecret !== 'string' ||
    !clientSecret.trim() ||
    clientSecret.length > 2048 ||
    /[\x00-\x1f]/.test(clientSecret)
  )
    return fail(400, 'Provide both the Google OAuth Client ID and Client Secret.');
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}
export function sharedClient(): PeopleOAuthClient {
  const c = configuration();
  if (process.env.GOOGLE_PEOPLE_REQUIRE_CUSTOM_CLIENT === 'true')
    fail(409, 'Save your account OAuth app credentials before connecting Google Contacts.');
  const id = process.env.GOOGLE_PEOPLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_PEOPLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) fail(503, 'Configure Google People credentials or save an account OAuth app.');
  return { ...credentials(id, secret), redirectUri: c.redirectUri, source: 'shared' };
}
export function contactResource(input: unknown) {
  if (typeof input !== 'string') return fail(400, 'Use the contact resourceName returned by Google.');
  const id = input.replace(/^people\//, '');
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(id) || id === 'me')
    fail(400, 'Use a contact ID, such as c123, not a URL or people/me.');
  return `people/${id}`;
}
export function sourceEtag(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f]/.test(value))
    return fail(400, 'source_etag is required; use metadata.sources[type=CONTACT].etag from a fresh contact read.');
  return value;
}
/** Google field arrays are replacements on update; preserve all desired entries. */
export function contactInput(input: any, update = false): Record<string, any[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Provide a contact JSON object.');
  const allowed = [...contactFields, ...(update ? ['source_etag'] : [])];
  if (Object.keys(input).some((k) => !allowed.includes(k as any)))
    fail(400, 'Supported contact fields are names, emailAddresses and phoneNumbers.');
  const result: Record<string, any[]> = {};
  for (const field of contactFields) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const rows = input[field];
    if (!Array.isArray(rows) || rows.length > (field === 'names' ? 1 : 20)) fail(400, `Invalid ${field} array.`);
    result[field] = rows.map((row: any) => {
      const keys =
        field === 'names'
          ? ['givenName', 'middleName', 'familyName', 'honorificPrefix', 'honorificSuffix']
          : ['value', 'type'];
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((k) => !keys.includes(k)))
        fail(400, `Invalid ${field} entry; output-only fields must be omitted.`);
      const value: Record<string, string> = {};
      for (const k of keys)
        if (row[k] !== undefined) {
          if (typeof row[k] !== 'string' || row[k].length > (k === 'type' ? 50 : 300) || /[\x00-\x1f]/.test(row[k]))
            fail(400, `Invalid ${field}.${k}.`);
          if (row[k].trim()) value[k] = row[k].trim();
        }
      if (field === 'names' ? !Object.keys(value).length : !value.value) fail(400, `Provide a value for ${field}.`);
      if (field === 'emailAddresses' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.value))
        fail(400, 'Invalid contact email address.');
      return value;
    });
  }
  if (!Object.keys(result).length || (!update && !Object.values(result).some((rows) => rows.length)))
    fail(400, 'Provide at least one name, email address or phone number.');
  return result;
}
