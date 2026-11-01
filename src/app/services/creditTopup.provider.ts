import axios from 'axios';
import { CustomError } from '@surefy/exceptions/CustomError';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export function liveCreditConfiguration() {
  const keyId = process.env.RAZORPAY_KEY_ID || '', secret = process.env.RAZORPAY_KEY_SECRET || '';
  if (!/^rzp_live_[A-Za-z0-9]+$/.test(keyId) || !secret)
    throw new CustomError('Configure the platform live Razorpay account before buying credits', 503);
  return { keyId, secret };
}

async function request(method: 'GET' | 'POST', path: string, data?: object, params?: object) {
  const configuration = liveCreditConfiguration();
  try {
    return (await axios.request({ method, baseURL: 'https://api.razorpay.com/v1', url: path,
      auth: { username: configuration.keyId, password: configuration.secret }, data, params,
      timeout: 15000, maxRedirects: 0 })).data;
  } catch {
    // Axios errors can contain credentials. Do not log or return the raw exception.
    throw new CustomError('Razorpay verification is temporarily unavailable. Retry this same credit purchase; do not pay again.', 503);
  }
}

const providerId = (value: string, prefix: string) => {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value)) throw new HTTP400Error({ message: 'Invalid Razorpay reference' });
  return value;
};

export async function createCreditQr(order: any) {
  return request('POST', '/payments/qr_codes', {
    type: 'upi_qr', name: 'SOFT7 Credits', usage: 'single_use', fixed_amount: true,
    payment_amount: order.amount_paise, close_by: Math.floor(new Date(order.expires_at).getTime() / 1000),
    description: `Soft7 company credit purchase ${order.id}`,
    notes: { purpose: 'company_credit_topup', credit_topup_id: order.id, company_id: order.company_id, user_id: order.user_id },
  });
}
export const fetchCreditQr = (id: string) => request('GET', `/payments/qr_codes/${providerId(id, 'qr')}`);
export const fetchCreditQrPayments = (id: string) => request('GET', `/payments/qr_codes/${providerId(id, 'qr')}/payments`, undefined, { count: 100 });
export const fetchCreditPayment = (id: string) => request('GET', `/payments/${providerId(id, 'pay')}`);

/** Recover ambiguous POST outcomes by its server-generated notes, never by amount alone. */
export async function recoverCreditQr(order: any) {
  const from = Math.floor(new Date(order.created_at).getTime() / 1000) - 60;
  for (let skip = 0; skip < 1000; skip += 100) {
    const page = await request('GET', '/payments/qr_codes', undefined, { count: 100, skip, from });
    if (!Array.isArray(page.items)) throw new CustomError('Unexpected Razorpay QR response', 503);
    const found = page.items.filter((qr: any) => qr.notes?.credit_topup_id === order.id);
    if (found.length > 1) throw new CustomError('Multiple payment QR codes need reconciliation. Do not pay again.', 409);
    if (found[0]) return found[0];
    if (page.items.length < 100) return null;
  }
  throw new CustomError('QR recovery requires reconciliation. Retry later without creating another payment.', 409);
}
