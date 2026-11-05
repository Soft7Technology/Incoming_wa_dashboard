import { createHmac, timingSafeEqual } from 'crypto';
import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';
import { decryptPaymentCredentials } from '../utils/paymentCredentials';

export function validPaymentLinkSignature(raw: Buffer | undefined, signature: string | undefined, secret: string) {
  if (!raw || !signature || !/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export async function receivePaymentLinkWebhook(gatewayId: string, raw: Buffer | undefined, signature: string | undefined) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gatewayId)) {
    throw new HTTP400Error({ message: 'Invalid gateway configuration ID' });
  }
  // Historical gateway versions still receive notifications for their purchases.
  const gateway = await db('company_payment_gateways').where({ id: gatewayId, provider: 'razorpay' }).first();
  if (!gateway || !gateway.webhook_secret_configured) throw new HTTP401Error({ message: 'Invalid webhook configuration' });
  const credentials = decryptPaymentCredentials(gateway.credentials_encrypted, `${gateway.company_id}:${gateway.id}`);
  if (!validPaymentLinkSignature(raw, signature, credentials.webhook_secret || '')) {
    throw new HTTP401Error({ message: 'Invalid Razorpay webhook signature' });
  }
  let event: any;
  try { event = JSON.parse(raw!.toString('utf8')); } catch {
    throw new HTTP400Error({ message: 'Invalid webhook JSON' });
  }
  if (!['payment_link.paid', 'payment_link.partially_paid', 'payment_link.expired', 'payment_link.cancelled'].includes(event?.event)) {
    return { received: true };
  }
  const link = event?.payload?.payment_link?.entity;
  if (!link || typeof link.id !== 'string' || !/^plink_[a-zA-Z0-9]+$/.test(link.id)) {
    return { received: true };
  }
  // Record the first signed payment-link delivery for this exact configuration.
  // Dashboard-created links can verify delivery without a local purchase.
  // This is not payment fulfillment or ongoing provider-health monitoring.
  await db('company_payment_gateways')
    .where({ id: gateway.id, company_id: gateway.company_id })
    .whereNull('webhook_verified_at')
    .update({ webhook_verified_at: new Date() });
  if (typeof link.reference_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(link.reference_id)) {
    return { received: true };
  }
  // Persist a wake-up before acknowledging. Never activate from payload fields;
  // the reconciler fetches this purchase using the original merchant credentials.
  // Duplicate/out-of-order events simply request another safe verification.
  await db('company_payment_orders')
    .where({ id: link.reference_id, gateway_id: gateway.id, company_id: gateway.company_id, payment_flow: 'link' })
    .whereNull('fulfilled_at')
    .where(function () { this.whereNull('provider_payment_link_id').orWhere('provider_payment_link_id', link.id); })
    .update({ next_check_at: new Date() });
  return { received: true };
}
