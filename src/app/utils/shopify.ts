import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { CustomError } from '@surefy/exceptions/CustomError';

export interface ShopifyScope {
  companyId: string;
  ownerId: string;
  userId: string;
}
export const fail = (status: number, message: string): never => {
  throw new CustomError(message, status);
};
export const random = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const topics: Readonly<Record<string, { label: string; scope: string; key: string }>> = {
  'orders/create': { label: 'New order', scope: 'read_orders', key: 'ORDERS_CREATE' },
  'orders/paid': { label: 'Paid order', scope: 'read_orders', key: 'ORDERS_PAID' },
  'orders/cancelled': { label: 'Cancelled order', scope: 'read_orders', key: 'ORDERS_CANCELLED' },
  'orders/updated': { label: 'Updated order', scope: 'read_orders', key: 'ORDERS_UPDATED' },
  'customers/create': { label: 'New customer', scope: 'read_customers', key: 'CUSTOMERS_CREATE' },
};
export const lifecycle = ['app/uninstalled', 'app/scopes_update'];
export const compliance = ['customers/data_request', 'customers/redact', 'shop/redact'];
// Receipt-only manual tests may cover these events without enabling message automation.
export const flowTestTopics = [
  ...Object.keys(topics),
  'carts/create',
  'carts/update',
  'checkouts/create',
  'checkouts/update',
  'checkouts/delete',
];
export function owner(scope: ShopifyScope) {
  if (!scope.companyId || !scope.ownerId || scope.ownerId !== scope.userId)
    fail(403, 'Only the account owner can manage Shopify connections.');
}
export function shopDomain(input: unknown): string {
  if (typeof input !== 'string') return fail(400, 'Enter your store name or its myshopify.com domain.');
  let value = input.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) value += '.myshopify.com';
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(value))
    fail(400, 'Use the store name or exact store.myshopify.com domain, without a URL or path.');
  return value;
}
export function identifier(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  )
    return fail(400, 'Invalid Shopify connection ID.');
  return input;
}
function encryptionKey() {
  const key = Buffer.from(process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) fail(503, 'SHOPIFY_TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as base64.');
  return key;
}
export function shopifyApiVersion() {
  const version = process.env.SHOPIFY_API_VERSION || '2026-10';
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) fail(503, 'Invalid SHOPIFY_API_VERSION.');
  return version;
}
export function configuration() {
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim(),
    clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  let url: URL;
  try {
    url = new URL(process.env.SHOPIFY_REDIRECT_URI || '');
  } catch {
    return fail(503, 'Set SHOPIFY_REDIRECT_URI to the HTTPS Shopify callback URL.');
  }
  if (!clientId || !clientSecret) fail(503, 'Shopify app credentials are not configured.');
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/integrations/shopify/callback'
  )
    fail(503, 'SHOPIFY_REDIRECT_URI must be the HTTPS /v1/integrations/shopify/callback URL.');
  const scopes = (process.env.SHOPIFY_SCOPES || 'read_orders,read_customers')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!scopes.length || scopes.some((s) => !['read_orders', 'read_customers', 'read_products'].includes(s)))
    fail(503, 'This Shopify integration supports read_orders, read_customers and read_products scopes.');
  const apiVersion = shopifyApiVersion();
  encryptionKey();
  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: url.toString(),
    origin: url.origin,
    secure: url.protocol === 'https:',
    scopes: [...new Set(scopes)],
    apiVersion,
  };
}
export function encrypt(value: string, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`shopify:${context}`));
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((v) => v.toString('base64')).join('.');
}
export function decrypt(value: string, context: string) {
  try {
    const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(`shopify:${context}`));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
  } catch {
    return fail(503, 'Saved Shopify credentials cannot be decrypted. Check the encryption key.');
  }
}
export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyCallback(query: Record<string, unknown>) {
  if (Object.values(query).some((v) => typeof v !== 'string')) fail(400, 'Invalid Shopify callback parameters.');
  const q = query as Record<string, string>;
  if (!/^[a-f0-9]{64}$/i.test(q.hmac || '')) fail(401, 'Invalid Shopify callback signature.');
  const message = Object.entries(q)
    .filter(([k]) => k !== 'hmac')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const digest = createHmac('sha256', configuration().clientSecret).update(message).digest('hex');
  if (!equalSecret(digest, q.hmac.toLowerCase())) fail(401, 'Invalid Shopify callback signature.');
  if (!/^\d{10}$/.test(q.timestamp || '') || Math.abs(Date.now() / 1000 - Number(q.timestamp)) > 600)
    fail(400, 'Shopify callback expired. Start Connect Shopify again.');
  return q;
}
export function verifyWebhook(raw: Buffer | undefined, signature: unknown, signingSecret?: string) {
  if (
    !Buffer.isBuffer(raw) ||
    !raw.length ||
    raw.length > 1024 * 1024 ||
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(signature)
  )
    fail(401, 'Invalid Shopify webhook signature or body.');
  const expected = createHmac('sha256', signingSecret ?? configuration().clientSecret)
    .update(raw!)
    .digest('base64');
  if (!equalSecret(expected, signature as string)) fail(401, 'Invalid Shopify webhook signature.');
}

export const scalarId = (value: unknown): string | null =>
  (typeof value === 'string' && /^[A-Za-z0-9:/_-]{1,150}$/.test(value)) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    ? String(value)
    : null;
const shortText = (value: unknown, max = 100) => (typeof value === 'string' ? value.slice(0, max) : undefined);
export function retentionDays() {
  const days = Number(process.env.SHOPIFY_EVENT_RETENTION_DAYS || 30);
  if (!Number.isInteger(days) || days < 1 || days > 30)
    fail(503, 'SHOPIFY_EVENT_RETENTION_DAYS must be an integer from 1 to 30.');
  return days;
}
export const expiresAt = (date = new Date(), days = retentionDays()) => new Date(date.getTime() + days * 86400000);

// Allowlist event data. Never keep webhook notes, addresses, names, line items or contact details in the inbox.
export function minimizePayload(topic: string, input: any): Record<string, any> {
  const value = input && typeof input === 'object' ? input : {};
  if (compliance.includes(topic)) {
    const orders = topic === 'customers/redact' ? 'orders_to_redact' : 'orders_requested';
    return {
      shop_id: scalarId(value.shop_id),
      shop_domain: shortText(value.shop_domain),
      customer: { id: scalarId(value.customer?.id) },
      [orders]: Array.isArray(value[orders]) ? [...new Set(value[orders].map(scalarId).filter(Boolean))] : [],
      ...(topic === 'customers/data_request' ? { data_request: { id: scalarId(value.data_request?.id) } } : {}),
    };
  }
  if (lifecycle.includes(topic))
    return {
      id: scalarId(value.id),
      ...(topic === 'app/scopes_update'
        ? {
            current: Array.isArray(value.current)
              ? value.current.filter((s: unknown) => typeof s === 'string' && /^[a-z_]{1,100}$/.test(s))
              : [],
          }
        : {}),
    };
  return {
    id: scalarId(value.id),
    ...(topic.startsWith('orders/')
      ? {
          customer: { id: scalarId(value.customer?.id) },
          financial_status: shortText(value.financial_status, 40),
          fulfillment_status: shortText(value.fulfillment_status, 40),
        }
      : {}),
    ...Object.fromEntries(
      ['created_at', 'updated_at', 'cancelled_at', 'processed_at']
        .filter((k) => typeof value[k] === 'string' && Number.isFinite(Date.parse(value[k])))
        .map((k) => [k, new Date(value[k]).toISOString()]),
    ),
  };
}

// Keyed hashes permit erasure/export matching without retaining contact values in normal events.
export function subjectHashes(topic: string, value: any, ctx: string): string[] {
  if (lifecycle.includes(topic)) return [];
  const values: string[] = [];
  const add = (kind: string, item: unknown) => {
    const id = scalarId(item);
    if (id) values.push(`${kind}:${id}`);
  };
  if (topic === 'customers/create') add('customer', value?.id);
  else add('customer', value?.customer?.id);
  if (topic.startsWith('orders/')) add('order', value?.id);
  if (topic.startsWith('checkouts/')) add('order', value?.order_id);
  for (const field of ['orders_requested', 'orders_to_redact'])
    if (Array.isArray(value?.[field])) for (const id of value[field]) add('order', id);
  for (const item of [value, value?.customer, value?.billing_address, value?.shipping_address]) {
    if (typeof item?.email === 'string' && item.email.trim() && item.email.length <= 320)
      values.push(`email:${item.email.trim().toLowerCase()}`);
    if (typeof item?.phone === 'string' && item.phone.length <= 100) {
      const phone = item.phone.replace(/[^0-9]/g, '');
      if (phone) values.push(`phone:${phone}`);
    }
  }
  return [...new Set(values)].map((v) =>
    createHmac('sha256', encryptionKey()).update(`shopify:privacy:${ctx}:${v}`).digest('hex'),
  );
}

export function privacyIdentity() {
  const controller = process.env.SHOPIFY_PRIVACY_CONTROLLER?.trim() || '';
  const email = process.env.SHOPIFY_PRIVACY_EMAIL?.trim() || '';
  if (!controller || controller.length > 150 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    fail(503, 'Set SHOPIFY_PRIVACY_CONTROLLER and SHOPIFY_PRIVACY_EMAIL before publishing the privacy page.');
  return { controller, email };
}
