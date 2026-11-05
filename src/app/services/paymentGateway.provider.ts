import axios from 'axios';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export type PaymentProvider = 'razorpay' | 'cashfree';
export type PaymentMode = 'test' | 'live';
export interface GatewayConnection {
  provider: PaymentProvider;
  mode: PaymentMode;
  credentials: { key_id: string; key_secret: string };
}

async function request(gateway: GatewayConnection, method: 'GET' | 'POST', path: string, data?: object, id?: string) {
  const razorpay = gateway.provider === 'razorpay';
  const baseURL = razorpay ? 'https://api.razorpay.com/v1'
    : gateway.mode === 'test' ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
  try {
    const response = await axios.request({
      baseURL, url: path, method, data, timeout: 15000, maxRedirects: 0,
      ...(razorpay ? { auth: { username: gateway.credentials.key_id, password: gateway.credentials.key_secret } } : {
        headers: {
          'x-client-id': gateway.credentials.key_id, 'x-client-secret': gateway.credentials.key_secret,
          'x-api-version': '2026-01-01', ...(id ? { 'x-idempotency-key': id } : {}),
        },
      }),
    });
    return response.data;
  } catch {
    // Axios errors contain request headers and credentials; never forward or log them.
    throw new HTTP400Error({ message: 'Gateway request failed. Check gateway credentials and dashboard; retry verification before creating another payment.' });
  }
}

export async function createGatewayOrder(gateway: GatewayConnection, order: {
  id: string; amount_paise: number; user_id: string; customer_phone: string; display_name: string;
}) {
  if (gateway.provider === 'razorpay') {
    const result = await request(gateway, 'POST', '/orders', {
      amount: order.amount_paise, currency: 'INR', receipt: order.id,
    });
    if (typeof result.id !== 'string' || result.amount !== order.amount_paise || result.currency !== 'INR') {
      throw new HTTP400Error({ message: 'Unexpected gateway order response' });
    }
    return { provider_order_id: result.id, checkout: {
      provider: gateway.provider, mode: gateway.mode, key: gateway.credentials.key_id,
      order_id: result.id, amount: order.amount_paise, currency: 'INR', name: order.display_name,
    } };
  }
  const result = await request(gateway, 'POST', '/orders', {
    order_id: order.id, order_amount: order.amount_paise / 100, order_currency: 'INR',
    customer_details: { customer_id: order.user_id, customer_phone: order.customer_phone },
  }, order.id);
  if (result.order_id !== order.id || typeof result.payment_session_id !== 'string'
    || Math.round(Number(result.order_amount) * 100) !== order.amount_paise || result.order_currency !== 'INR') {
    throw new HTTP400Error({ message: 'Unexpected gateway order response' });
  }
  return { provider_order_id: result.order_id, checkout: {
    provider: gateway.provider, mode: gateway.mode, payment_session_id: result.payment_session_id,
    order_id: result.order_id, name: order.display_name,
  } };
}

export async function verifyGatewayOrder(gateway: GatewayConnection, order: { provider_order_id: string; amount_paise: number }) {
  const result = await request(gateway, 'GET', `/orders/${encodeURIComponent(order.provider_order_id)}`);
  const razorpay = gateway.provider === 'razorpay';
  const id = razorpay ? result.id : result.order_id;
  const amount = razorpay ? result.amount : Math.round(Number(result.order_amount) * 100);
  const currency = razorpay ? result.currency : result.order_currency;
  if (id !== order.provider_order_id || amount !== order.amount_paise || currency !== 'INR') {
    throw new HTTP400Error({ message: 'Gateway order identity, amount or currency does not match' });
  }
  // Only the authenticated gateway response can mark an order paid, never browser input.
  return razorpay ? result.status === 'paid' && result.amount_paid === order.amount_paise
    && result.amount_due === 0 : result.order_status === 'PAID';
}

type LinkPurchase = { id: string; amount_paise: number; provider_payment_link_id?: string | null };

function validatePaymentLink(link: any, purchase: LinkPurchase) {
  if (!link || typeof link.id !== 'string' || !/^plink_[a-zA-Z0-9]+$/.test(link.id) ||
    (purchase.provider_payment_link_id && link.id !== purchase.provider_payment_link_id) ||
    link.reference_id !== purchase.id || link.amount !== purchase.amount_paise ||
    link.currency !== 'INR' || link.accept_partial !== false ||
    !['created', 'paid', 'partially_paid', 'cancelled', 'expired'].includes(link.status)) {
    throw new HTTP400Error({ message: 'Payment link identity, reference, amount or currency does not match the purchase' });
  }
  let url: URL;
  try { url = new URL(link.short_url); } catch {
    throw new HTTP400Error({ message: 'Invalid payment link URL returned by gateway' });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !['rzp.io', 'rzp.in', 'razorpay.com'].includes(url.hostname)) {
    throw new HTTP400Error({ message: 'Unexpected payment link URL returned by gateway' });
  }
  return link;
}

export async function createGatewayPaymentLink(gateway: GatewayConnection, purchase: LinkPurchase & { customer_phone: string }) {
  if (gateway.provider !== 'razorpay') throw new HTTP400Error({ message: 'Payment links require a Razorpay gateway' });
  const link = await request(gateway, 'POST', '/payment_links', {
    amount: purchase.amount_paise, currency: 'INR', accept_partial: false,
    reference_id: purchase.id, description: 'Subscription plan purchase',
    ...(purchase.customer_phone ? { customer: { contact: purchase.customer_phone } } : {}),
    notify: { sms: false, email: false }, reminder_enable: false,
    expire_by: Math.floor(Date.now() / 1000) + 3600,
  });
  return validatePaymentLink(link, purchase);
}

export async function fetchGatewayPaymentLink(gateway: GatewayConnection, purchase: LinkPurchase) {
  if (gateway.provider !== 'razorpay') throw new HTTP400Error({ message: 'Payment links require a Razorpay gateway' });
  if (purchase.provider_payment_link_id) {
    return validatePaymentLink(await request(gateway, 'GET', `/payment_links/${encodeURIComponent(purchase.provider_payment_link_id)}`), purchase);
  }
  // Recover a POST accepted upstream before a timeout/crash. Never repeat POST.
  const result = await request(gateway, 'GET', `/payment_links?reference_id=${encodeURIComponent(purchase.id)}`);
  if (!Array.isArray(result.payment_links)) throw new HTTP400Error({ message: 'Unexpected payment link lookup response' });
  const matches = result.payment_links.filter((link: any) => link.reference_id === purchase.id);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new HTTP400Error({ message: 'Multiple payment links require reconciliation' });
  return validatePaymentLink(matches[0], purchase);
}

export async function paymentLinkHasCapturedPayment(gateway: GatewayConnection, link: any, purchase: LinkPurchase) {
  if (link.status !== 'paid' || link.amount_paid !== purchase.amount_paise) return false;
  if (typeof link.order_id !== 'string' || !/^order_[a-zA-Z0-9]+$/.test(link.order_id)) {
    throw new HTTP400Error({ message: 'Paid payment link has no valid provider order' });
  }
  const result = await request(gateway, 'GET', `/orders/${encodeURIComponent(link.order_id)}/payments`);
  if (!Array.isArray(result.items)) throw new HTTP400Error({ message: 'Unexpected payment capture response' });
  // A link can remain paid after a refund. Do not grant a new plan from a
  // refunded/authorized payment when first fulfilling or retrying activation.
  return result.items.some((payment: any) => payment.order_id === link.order_id &&
    payment.status === 'captured' && payment.captured === true && payment.amount_refunded === 0 &&
    payment.amount === purchase.amount_paise && payment.currency === 'INR');
}

export function paymentLinkCheckout(gateway: GatewayConnection, link: any) {
  return { provider: 'razorpay', mode: gateway.mode, type: 'payment_link',
    payment_link_id: link.id, payment_url: link.short_url,
    expires_at: Number.isSafeInteger(link.expire_by) && link.expire_by > 0 ? new Date(link.expire_by * 1000).toISOString() : null };
}
