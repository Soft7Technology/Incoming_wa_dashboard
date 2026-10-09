import crypto from 'crypto';

export class FacebookError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'FACEBOOK_ERROR',
  ) {
    super(message);
  }
}

export const permissions = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'];
export const subscriptions = ['messages', 'message_echoes', 'message_deliveries', 'message_reads'];
export const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const random = () => crypto.randomBytes(32).toString('base64url');
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function publicOrigin() {
  if (!process.env.FACEBOOK_PUBLIC_URL) throw new FacebookError(503, 'FACEBOOK_PUBLIC_URL is required.');
  const base = process.env.FACEBOOK_PUBLIC_URL.replace(/\/$/, '');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new FacebookError(503, 'FACEBOOK_PUBLIC_URL must be a valid HTTPS origin.');
  }
  if (
    (url.protocol !== 'https:' &&
      !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new FacebookError(
      503,
      'FACEBOOK_PUBLIC_URL must be an HTTPS origin (localhost HTTP is allowed in development).',
    );
  }
  return { base, secure: url.protocol === 'https:' };
}

export function config() {
  const required = [
    'FACEBOOK_APP_ID',
    'FACEBOOK_APP_SECRET',
    'FACEBOOK_GRAPH_VERSION',
    'FACEBOOK_PUBLIC_URL',
    'FACEBOOK_TOKEN_ENCRYPTION_KEY',
    'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
    'JWT_SECRET',
  ];
  if (process.env.FACEBOOK_LOGIN_MODE !== 'classic') required.push('FACEBOOK_LOGIN_CONFIG_ID');
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length)
    throw new FacebookError(503, `Facebook configuration missing: ${missing.join(', ')}`, 'CONFIGURATION_REQUIRED');
  const { base, secure } = publicOrigin();
  if (!/^v\d+\.\d+$/.test(process.env.FACEBOOK_GRAPH_VERSION!))
    throw new FacebookError(503, 'Set an active Facebook Graph API version.');
  encryptionKey();
  return {
    base,
    secure,
    appId: process.env.FACEBOOK_APP_ID!,
    secret: process.env.FACEBOOK_APP_SECRET!,
    version: process.env.FACEBOOK_GRAPH_VERSION!,
    callback: `${base}/v1/facebook/oauth/callback`,
  };
}

function encryptionKey(): Buffer {
  const key = Buffer.from(process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32)
    throw new FacebookError(503, 'FACEBOOK_TOKEN_ENCRYPTION_KEY must encode 32 random bytes in base64.');
  return key;
}
export function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['fb1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
export function decrypt(value: string): string {
  const [version, iv, tag, encrypted] = value.split('.');
  if (version !== 'fb1' || !iv || !tag || !encrypted)
    throw new FacebookError(503, 'Stored Facebook credentials are invalid; reconnect the Page.');
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64')), cipher.final()]).toString('utf8');
  } catch {
    throw new FacebookError(503, 'Cannot decrypt Facebook credentials; check encryption key or reconnect.');
  }
}

export function verifySignature(body: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function signedUser(signed: unknown, secret: string): string {
  if (typeof signed !== 'string' || signed.length > 10000) throw new FacebookError(400, 'Invalid signed request.');
  const parts = signed.split('.');
  if (parts.length !== 2) throw new FacebookError(400, 'Invalid signed request.');
  const signature = Buffer.from(parts[0], 'base64url');
  const expected = crypto.createHmac('sha256', secret).update(parts[1]).digest();
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected))
    throw new FacebookError(403, 'Invalid signed request signature.');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new FacebookError(400, 'Invalid signed request payload.');
  }
  if (payload.algorithm !== 'HMAC-SHA256' || typeof payload.user_id !== 'string' || !/^\d+$/.test(payload.user_id))
    throw new FacebookError(400, 'Invalid signed request user.');
  return payload.user_id;
}

export function replyWindow(last: unknown, now = Date.now()) {
  const end = last ? new Date(last as string).getTime() + 24 * 60 * 60 * 1000 : 0;
  return {
    can_reply: end > now,
    reply_window_ends_at: end ? new Date(end).toISOString() : null,
    reply_block_reason:
      end > now
        ? null
        : 'The 24-hour Messenger reply window is closed. Ask the customer to message this Page again in Messenger.',
  };
}

// Meta errors are translated to safe messages; never propagate HTTP client errors,
// which can include Authorization headers, access tokens and authorization codes.
export function graphFailure(code: number): FacebookError {
  if (code === 190)
    return new FacebookError(
      409,
      'Facebook authorization expired or was revoked. Reconnect this Page.',
      'TOKEN_EXPIRED',
    );
  if ([10, 200, 299].includes(code))
    return new FacebookError(
      403,
      'Facebook denied permission. Grant the required permissions and verify your Page messaging task and app access level.',
      'PERMISSION_DENIED',
    );
  if ([4, 17, 32, 613].includes(code))
    return new FacebookError(429, 'Meta rate limit reached. Wait before sending another reply.', 'RATE_LIMITED');
  if (code === 551)
    return new FacebookError(
      409,
      'This person is currently unavailable to receive a Messenger reply.',
      'RECIPIENT_UNAVAILABLE',
    );
  return new FacebookError(
    502,
    `Meta rejected the request (code ${Number.isFinite(code) ? code : 0}). Check app configuration, Page access and the messaging window.`,
    'META_REJECTED',
  );
}
