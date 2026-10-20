import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { CustomError } from '@surefy/exceptions/CustomError';
import { parseImportedPhone } from './importPhone';

export const googleFileScope = 'https://www.googleapis.com/auth/drive.file';
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const fail = (status: number, message: string): never => {
  throw new CustomError(message, status);
};
export const random = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export interface GoogleScope {
  companyId: string;
  ownerId: string;
  userId: string;
}
export interface SheetMapping {
  phone: string;
  name?: string;
  email?: string;
  country_code?: string;
}

export function configuration() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) fail(503, 'Google Sheets OAuth credentials are not configured.');
  let url: URL;
  try {
    url = new URL(redirectUri!);
  } catch {
    return fail(503, 'Invalid GOOGLE_REDIRECT_URI.');
  }
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/integrations/google/callback'
  ) {
    fail(
      503,
      'GOOGLE_REDIRECT_URI must be the HTTPS /v1/integrations/google/callback URL (localhost HTTP is allowed).',
    );
  }
  encryptionKey();
  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    secure: url.protocol === 'https:',
  };
}

function encryptionKey() {
  const key = Buffer.from(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) fail(503, 'GOOGLE_TOKEN_ENCRYPTION_KEY must contain 32 random bytes encoded as base64.');
  return key;
}

const aad = (scope: Pick<GoogleScope, 'companyId' | 'ownerId'>) =>
  Buffer.from(`google-sheets:${scope.companyId}:${scope.ownerId}`);
export function encrypt(value: string, scope: Pick<GoogleScope, 'companyId' | 'ownerId'>) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(aad(scope));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64')).join('.');
}
export function decrypt(value: string, scope: Pick<GoogleScope, 'companyId' | 'ownerId'>) {
  try {
    const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(aad(scope));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
  } catch {
    return fail(503, 'Saved Google credentials cannot be decrypted. Check the encryption key or reconnect.');
  }
}

export function owner(scope: GoogleScope) {
  if (!scope.companyId || !scope.userId || scope.userId !== scope.ownerId)
    fail(403, 'Only the account owner can manage Google Sheets.');
}
export function spreadsheetId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(value))
    fail(400, 'A valid spreadsheet_id is required (use the ID, not a URL).');
  return value as string;
}
export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${label} must be a UUID.`);
  return value as string;
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Normalize once at preview time; the worker imports exactly this saved snapshot. */
export function parseSheet(values: unknown[][], mapping: SheetMapping, countryCode = '') {
  if (!Array.isArray(values) || values.length < 2) fail(400, 'The selected tab has no contact rows.');
  const headers = values[0].map((h) => String(h ?? '').trim());
  if (
    !headers.length ||
    headers.length > 100 ||
    headers.some((h) => !h || h.length > 120 || ['__proto__', 'constructor', 'prototype'].includes(h)) ||
    new Set(headers.map((h) => h.toLowerCase())).size !== headers.length
  )
    fail(400, 'Use unique, non-empty column headers (at most 100 columns).');
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || typeof mapping.phone !== 'string')
    fail(400, 'mapping.phone must name the phone column.');
  const selected = Object.values(mapping).filter((v) => v !== undefined);
  if (
    selected.some((v) => typeof v !== 'string' || !headers.includes(v)) ||
    new Set(selected).size !== selected.length ||
    Object.keys(mapping).some((k) => !['phone', 'name', 'email', 'country_code'].includes(k))
  )
    fail(400, 'Column mappings must reference distinct existing headers.');
  const extras = headers.filter((h) => !selected.includes(h));
  if (extras.some((h) => ['phone_number', 'name', 'email', 'country_code'].includes(h)))
    fail(400, 'Map reserved columns phone_number, name, email and country_code, or rename them.');
  const outputHeaders = ['phone_number', 'name', 'email', 'country_code', ...extras];
  const rows: any[][] = [],
    seen = new Set<string>();
  const errors: Array<{ row: number; message: string }> = [];
  let duplicates = 0,
    invalid = 0,
    total = 0;
  for (const [index, cells] of values.slice(1).entries()) {
    if (!Array.isArray(cells)) fail(400, 'Invalid spreadsheet row.');
    if (cells.every((c) => c === '' || c === null || c === undefined)) continue;
    total++;
    const get = (column?: string) => (column ? (cells[headers.indexOf(column)] ?? '') : '');
    try {
      if (cells.length > headers.length && cells.slice(headers.length).some((v) => v !== '' && v !== null))
        throw new Error('Data exists in columns without headers.');
      const rowCode = String(get(mapping.country_code)).trim();
      const phone = parseImportedPhone(get(mapping.phone), rowCode || countryCode, Boolean(rowCode));
      const full = `+${phone.country_code}${phone.phone_number}`;
      if (seen.has(full)) {
        duplicates++;
        continue;
      }
      seen.add(full);
      rows.push([
        full,
        String(get(mapping.name)).trim(),
        String(get(mapping.email)).trim(),
        phone.country_code,
        ...extras.map(get),
      ]);
    } catch (e) {
      invalid++;
      if (errors.length < 100)
        errors.push({ row: index + 2, message: e instanceof Error ? e.message : 'Invalid contact row.' });
    }
  }
  return {
    headers: outputHeaders,
    rows,
    summary: { total_rows: total, valid_rows: rows.length, invalid_rows: invalid, duplicate_rows: duplicates, errors },
  };
}
