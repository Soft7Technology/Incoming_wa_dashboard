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
