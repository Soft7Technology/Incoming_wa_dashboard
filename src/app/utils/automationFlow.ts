import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { CustomError } from '@surefy/exceptions/CustomError';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const fail = (status: number, message: string): never => { throw new CustomError(message, status); };
export interface FlowScope { userId?: string; companyId?: string }
export const uuid = (value: unknown, field = 'id'): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail(400, `${field} must be a UUID`);
  return (value as string).toLowerCase();
};
export const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'A JSON object is required');
  return value as Record<string, any>;
};
/** Derive contact fields without changing Shopify's original payload or guessing a country. */
export function shopifyContact(payload: any) {
  const normalize = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length > 100 || !/^(\+|00)/.test(value.trim())) return null;
    try {
      const phone = parsePhoneNumberFromString(value.trim().replace(/^00/, '+'), { extract: false });
      return phone?.isValid() && !phone.ext ? phone.number : null;
    } catch { return null; }
  };
  const candidates = [
    { source: 'phone', value: payload?.phone },
    { source: 'customer.phone', value: payload?.customer?.phone },
    { source: 'billing_address.phone', value: payload?.billing_address?.phone },
  ];
  const present = (value: unknown) => value !== undefined && value !== null && value !== '' && !(typeof value === 'string' && !value.trim());
  const selected = candidates.map(candidate => ({ ...candidate, normalized: normalize(candidate.value) })).find(candidate => candidate.normalized);
  const shipping = payload?.shipping_address?.phone, shippingPhone = normalize(shipping);
  const name = [payload?.customer?.first_name, payload?.customer?.last_name]
    .filter((part): part is string => typeof part === 'string')
    .map(part => part.trim()).filter(Boolean).join(' ');
  return {
    name: name || null,
    phone: selected?.normalized || null,
    phone_source: selected?.source || null,
    phone_status: selected ? 'available' : candidates.some(candidate => present(candidate.value)) ? 'invalid' : 'missing',
    shipping_phone: shippingPhone,
    shipping_phone_status: shippingPhone ? 'available' : present(shipping) ? 'invalid' : 'missing',
  };
}
export const text = (value: unknown, field: string, max = 255): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `${field} must contain 1-${max} characters`);
  return (value as string).trim();
};
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
function encryptionKey() {
  const configured = process.env.AUTOMATION_ENCRYPTION_KEY;
  const key = configured ? Buffer.from(configured, 'base64') : Buffer.from(process.env.PAYMENT_GATEWAY_ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) fail(503, 'Configure AUTOMATION_ENCRYPTION_KEY as 32 random bytes encoded as base64');
  return key;
}
export function encrypt(value: unknown, context: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`automation:${context}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
}
export function decrypt(value: string, context: string): any {
  try {
    const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(`automation:${context}`)); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  } catch { return fail(503, 'Saved automation data cannot be decrypted; check the encryption key'); }
}
export function publicOrigin() {
  let url: URL;
  try {
    const configured = process.env.AUTOMATION_PUBLIC_BASE_URL;
    url = new URL(configured || new URL(process.env.SHOPIFY_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || '').origin);
  } catch { return fail(503, 'Configure AUTOMATION_PUBLIC_BASE_URL with the public API origin'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail(503, 'AUTOMATION_PUBLIC_BASE_URL must be an HTTPS origin (localhost HTTP is allowed)');
  return url.origin;
}
export function verifySignature(raw: Buffer, signature: unknown, secret: string, provider: string) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 1024 * 1024) fail(400, 'A raw JSON webhook body of at most 1 MB is required');
  const encoding = provider === 'shopify' ? 'base64' : 'hex';
  if (typeof signature !== 'string' || !(provider === 'shopify' ? /^[A-Za-z0-9+/]{43}=$/ : /^[a-f0-9]{64}$/i).test(signature)) fail(401, 'Invalid webhook signature');
  const expected = createHmac('sha256', secret).update(raw).digest();
  const actual = Buffer.from(signature as string, encoding);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(401, 'Invalid webhook signature');
}

type Field = { type: 'string' | 'integer' | 'rows' | 'object'; required?: boolean; max?: number; description?: string };
export interface FlowAction { appKey: string; key: string; name: string; write: boolean; note?: string; parameters: Record<string, Field> }
export const actions: FlowAction[] = [
  { appKey: 'shopify', key: 'getOrder', name: 'Get order', write: false, parameters: { order_id: { type: 'string', required: true } } },
  { appKey: 'shopify', key: 'listOrders', name: 'List orders', write: false, parameters: { query: { type: 'string' }, limit: { type: 'integer', max: 50 }, after: { type: 'string' } } },
  { appKey: 'shopify', key: 'getProduct', name: 'Get product', write: false, parameters: { product_id: { type: 'string', required: true } } },
  { appKey: 'shopify', key: 'listProducts', name: 'List products', write: false, parameters: { query: { type: 'string' }, limit: { type: 'integer', max: 50 }, after: { type: 'string' } } },
  { appKey: 'google-sheets', key: 'createSpreadsheet', name: 'Create spreadsheet', write: true, parameters: { title: { type: 'string', required: true }, sheet_title: { type: 'string' } } },
  { appKey: 'google-sheets', key: 'getRows', name: 'Get rows', write: false, parameters: { spreadsheet_id: { type: 'string', required: true }, range: { type: 'string', required: true } } },
  { appKey: 'google-sheets', key: 'appendRows', name: 'Append rows', write: true, parameters: { spreadsheet_id: { type: 'string', required: true }, range: { type: 'string', required: true }, values: { type: 'rows', required: true } } },
  { appKey: 'google-sheets', key: 'updateRows', name: 'Update rows', write: true, parameters: { spreadsheet_id: { type: 'string', required: true }, range: { type: 'string', required: true }, values: { type: 'rows', required: true } } },
  { appKey: 'razorpay', key: 'createPaymentLink', name: 'Create payment link', write: true, parameters: { amount_paise: { type: 'integer', max: 100000000, required: true }, description: { type: 'string', required: true }, customer_name: { type: 'string' }, customer_email: { type: 'string' }, customer_contact: { type: 'string' } } },
  // WhatsApp: the step's connection is one of the account's active WhatsApp numbers (phone_numbers.id).
  { appKey: 'whatsapp', key: 'sendTemplate', name: 'Send template', write: true, note: 'Send an approved template. If the recipient is missing from Contacts for this sender, create the contact before sending. Map the recipient, contact details and variables from the trigger or earlier actions.', parameters: {
    to: { type: 'string', required: true, description: "The recipient's phone number, in international format (e.g. +919876543210)." },
    country_code: { type: 'string', description: 'Only needed when "To" has no country code, e.g. 91.' },
    contact_name: { type: 'string', max: 255, description: 'Name for a new contact, e.g. {{contact.name}} or a customer name from an earlier step. Defaults to the recipient number. Existing contacts are unchanged.' },
    contact_email: { type: 'string', max: 255, description: 'Email for a new contact, e.g. {{trigger.email}}. Existing contacts are unchanged.' },
    template_id: { type: 'string', required: true, description: 'An approved template of the selected WhatsApp number.' },
    variables: { type: 'object', description: 'Map the keys returned by the connection templates API, e.g. { "body.1": "{{trigger.customer.first_name}}", "body.2": "{{steps.PAYMENT_STEP_UUID.short_url}}" }. Text, numbers and booleans are accepted.' },
  } },
  { appKey: 'whatsapp', key: 'sendText', name: 'Send text message', write: true, note: 'WhatsApp only delivers free-form text within 24 hours of the customer last messaging you. Use "Send template" to start a conversation.', parameters: {
    to: { type: 'string', required: true, description: "The recipient's phone number, in international format (e.g. +919876543210)." },
    country_code: { type: 'string', description: 'Only needed when "To" has no country code, e.g. 91.' },
    message: { type: 'string', required: true, max: 4096, description: 'Up to 4096 characters.' },
  } },
  { appKey: 'razorpay', key: 'getPaymentLink', name: 'Get payment link', write: false, parameters: { payment_link_id: { type: 'string', required: true } } },
];
export const triggers = [
  { appKey: 'shopify', key: 'new_order', name: 'New Order', topic: 'orders/create' },
  { appKey: 'shopify', key: 'updated_order', name: 'Updated Order', topic: 'orders/updated' },
  { appKey: 'shopify', key: 'updated_cart', name: 'Updated Cart', topic: 'carts/update' },
  { appKey: 'shopify', key: 'paid_order', name: 'Paid Order', topic: 'orders/paid' },
  { appKey: 'shopify', key: 'new_customer', name: 'New Customer', topic: 'customers/create' },
  { appKey: 'razorpay', key: 'payment_captured', name: 'Payment Captured', topic: 'payment.captured' },
  { appKey: 'razorpay', key: 'payment_link_paid', name: 'Payment Link Paid', topic: 'payment_link.paid' },
  { appKey: 'razorpay', key: 'order_paid', name: 'Order Paid', topic: 'order.paid' },
];
export function action(appKey: unknown, key: unknown): FlowAction {
  return actions.find(item => item.appKey === appKey && item.key === key) || fail(400, `Unsupported integration action: ${String(appKey).slice(0, 40)}/${String(key).slice(0, 80)}. Update the automation worker to support this action.`);
}

/** Isolate development jobs when multiple deployments share the same database. */
export function queuedStatus() {
  const queue = process.env.AUTOMATION_QUEUE_NAME?.trim();
  if (!queue) return 'queued';
  if (!/^[a-z0-9_-]{1,20}$/.test(queue)) fail(503, 'AUTOMATION_QUEUE_NAME must contain 1-20 lowercase letters, digits, underscores or hyphens');
  return `queued:${queue}`;
}

const mappingParts = (path: string) => {
  const parts = path.trim().split('.');
  if (!['trigger', 'steps', 'contact'].includes(parts[0]) || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p) || ['__proto__', 'prototype', 'constructor'].includes(p))) fail(400, 'Invalid mapping path');
  return parts;
};

export function mappingPaths(value: any, depth = 0): string[] {
  if (depth > 20) fail(400, 'Parameter mapping is too deeply nested');
  if (typeof value === 'string') return Array.from(value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g), match => { mappingParts(match[1]); return match[1].trim(); });
  if (value && typeof value === 'object') return Object.values(value).flatMap(item => mappingPaths(item, depth + 1));
  return [];
}

/** Validate references before any provider writes, including every Sheet cell. */
export function validateStepMappings(steps: any[]) {
  const earlier = new Set<string>();
  for (const step of steps) {
    for (const path of mappingPaths(step.parameters)) {
      const parts = mappingParts(path);
      if (parts[0] === 'steps' && (parts.length < 3 || !earlier.has(parts[1]))) fail(400, `Mapping must reference an earlier action: ${path}`);
    }
    if (step.type === 'action') earlier.add(step._id);
  }
}

/** Resolve trigger/contact data now; previous-action outputs are checked at execution. */
export function resolveAvailableParameters(value: any, context: Record<string, any>, depth = 0): any {
  if (depth > 20) fail(400, 'Parameter mapping is too deeply nested');
  if (typeof value === 'string') {
    const paths = mappingPaths(value);
    for (const path of paths) if (!path.startsWith('steps.')) resolveParameters(`{{${path}}}`, context);
    return paths.some(path => path.startsWith('steps.')) ? value : resolveParameters(value, context);
  }
  if (Array.isArray(value)) return value.map(item => resolveAvailableParameters(item, context, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(400, 'Invalid parameter key');
    return [key, resolveAvailableParameters(item, context, depth + 1)];
  }));
  return value;
}
export function validateParameters(definition: FlowAction, value: unknown, templates = false) {
  const data = { ...object(value) };
  for (const key of Object.keys(data)) if (!definition.parameters[key]) fail(400, `Unsupported action parameter: ${key}`);
  for (const [key, field] of Object.entries(definition.parameters)) {
    let v = data[key];
    if (definition.appKey === 'whatsapp' && key === 'to' && typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 1e15) v = data[key] = String(v);
    if (v === undefined) { if (field.required) fail(400, `${key} is required`); continue; }
    if (templates && typeof v === 'string' && /\{\{[^{}]+\}\}/.test(v)) continue;
    if (field.type === 'string') text(v, key, field.max || (key === 'description' ? 2048 : 1000));
    if (field.type === 'integer' && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > (field.max || 100000000))) fail(400, `${key} must be a positive integer no greater than ${field.max || 100000000}`);
    if (field.type === 'object') {
      // Sheets/payment outputs can be numeric or boolean; template parameters are text.
      const entries = Object.entries(object(v));
      if (entries.length > 50 || entries.some(([k, item]) => !/^[A-Za-z0-9_.-]{1,80}$/.test(k) || ['__proto__', 'constructor', 'prototype'].includes(k) || !['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item)) || String(item).length > 1024)) fail(400, `${key} must map at most 50 names to text, numbers or booleans of up to 1024 characters`);
      data[key] = Object.fromEntries(entries.map(([name, item]) => [name, String(item)]));
    }
    if (field.type === 'rows') {
      if (!Array.isArray(v) || !v.length || v.length > 100 || v.some(row => !Array.isArray(row) || !row.length || row.length > 100 || row.some((cell: unknown) => cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)))) fail(400, 'values must contain 1-100 rows with at most 100 primitive cells each');
    }
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 128 * 1024) fail(413, 'Action parameters exceed 128 KB');
  return data;
}
export function resolveParameters(value: any, context: Record<string, any>, depth = 0): any {
  if (depth > 20) fail(400, 'Parameter mapping is too deeply nested');
  const lookup = (path: string) => {
    const parts = mappingParts(path);
    let current: any = context;
    for (const part of parts) { if (current == null || !Object.prototype.hasOwnProperty.call(current, part)) fail(400, `Mapping value is unavailable: ${path.trim()}`); current = current[part]; }
    return current;
  };
  if (typeof value === 'string') {
    const exact = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
    if (exact) return lookup(exact[1]);
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path) => {
      const found = lookup(path); if (found !== null && typeof found === 'object') fail(400, 'Use a whole-value mapping for arrays and objects'); return String(found ?? '');
    });
  }
  if (Array.isArray(value)) return value.map(item => resolveParameters(item, context, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(400, 'Invalid parameter key');
    return [key, resolveParameters(item, context, depth + 1)];
  }));
  return value;
}
