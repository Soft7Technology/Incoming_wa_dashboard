import db from '@surefy/database';
import { Knex } from 'knex';
import { createHash, randomUUID, createHmac, timingSafeEqual } from 'crypto';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CustomError } from '@surefy/exceptions/CustomError';
import * as v from '../utils/superAdminValidation';
import * as provider from './creditTopup.provider';
import { markActivityRecorded } from '../utils/activityContext';

export interface CreditTopupActor { userId?: string; companyId?: string; userRole?: string; idempotencyKey?: string; }
const orderTable = 'credit_topup_orders';
const paidStatuses = ['captured', 'refunded'];
function publicOrder(row: any) {
  return { id: row.id, company_id: row.company_id, amount_paise: row.amount_paise, currency: row.currency,
    status: row.status, qr_code_id: row.provider_qr_id, qr_image_url: row.qr_image_url,
    verification_required: 'razorpay_captured_payment', payment_id: row.provider_payment_id,
    paid_amount_paise: row.paid_amount_paise, refunded_amount_paise: row.refunded_amount_paise,
    credits_added: row.ledger_transaction_id ? (row.paid_amount_paise - row.refunded_amount_paise) / 100 : 0,
    transaction_id: row.ledger_transaction_id, expires_at: row.expires_at, credited_at: row.credited_at,
    created_at: row.created_at, last_checked_at: row.last_checked_at };
}
function walletPaise(value: unknown) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  const amount = match ? (match[1] ? -1 : 1) * (Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'))) : NaN;
  if (!Number.isSafeInteger(amount)) throw new HTTP400Error({ message: 'Company wallet balance needs reconciliation' });
  return amount;
}
function rupees(paise: number) {
  if (!Number.isSafeInteger(paise) || Math.abs(paise) > 999999999999999)
    throw new HTTP400Error({ message: 'Credit balance exceeds the supported maximum' });
  const amount = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

class CreditTopupService {
  private actor(actor: CreditTopupActor) {
    if (!['admin', 'company'].includes(actor.userRole || '') || !actor.userId || !actor.companyId)
      throw new HTTP403Error({ message: 'A company administrator is required to buy credits' });
    return { company_id: v.uuid(actor.companyId, 'companyId'), user_id: v.uuid(actor.userId, 'userId') };
  }

  options(actor: CreditTopupActor) {
    this.actor(actor);
    let ready = false;
    try { provider.liveCreditConfiguration(); ready = true; } catch { /* Report readiness without exposing secrets. */ }
    return { provider: 'razorpay', mode: 'live', merchant_name: 'SOFT7', currency: 'INR', ready,
      min_amount_paise: 100, max_amount_paise: 100000000, paise_per_credit: 100,
      qr_mode: 'single_use_per_purchase', expires_after_minutes: 15,
      reference_qr_image_url: '/v1/webhooks/razorpay/credits/reference-qr',
      instruction: 'Create a credit purchase and display its qr_image_url. After payment, verify that purchase. Credits are added only after Razorpay confirms capture.' };
  }

  private async find(actor: CreditTopupActor, id: string) {
    const scope = this.actor(actor);
    const row = await db(orderTable).where({ id: v.uuid(id, 'topupId'), company_id: scope.company_id }).first();
    if (!row) throw new HTTP404Error({ message: 'Credit purchase not found in your company' });
    return row;
  }

  async get(actor: CreditTopupActor, id: string) { return publicOrder(await this.find(actor, id)); }

  async list(actor: CreditTopupActor, query: Record<string, unknown>) {
    const scope = this.actor(actor); v.allowed(query, ['page', 'limit']);
    const f = v.filters(query), q = db(orderTable).where('company_id', scope.company_id);
    const [count, rows] = await Promise.all([q.clone().count('* as total').first(),
      q.clone().orderBy('created_at', 'desc').orderBy('id').limit(f.limit).offset((f.page - 1) * f.limit)]);
    return { data: rows.map(publicOrder), pagination: { page: f.page, limit: f.limit, total: Number(count?.total || 0) } };
  }

  private checkQr(qr: any, order: any) {
    v.requireInput(qr?.entity === 'qr_code' && /^qr_[A-Za-z0-9]+$/.test(qr.id || '') &&
      (!order.provider_qr_id || order.provider_qr_id === qr.id) && qr.type === 'upi_qr' &&
      qr.usage === 'single_use' && qr.fixed_amount === true && qr.payment_amount === order.amount_paise &&
      qr.notes?.purpose === 'company_credit_topup' && qr.notes.credit_topup_id === order.id &&
      qr.notes.company_id === order.company_id && qr.notes.user_id === order.user_id,
    'Razorpay QR does not match this company credit purchase');
    let image: URL | null = null;
    try { if (typeof qr.image_url === 'string') image = new URL(qr.image_url); } catch { /* Invalid provider response. */ }
    v.requireInput(image?.protocol === 'https:' && !image.username && !image.password, 'Invalid Razorpay QR image URL');
  }

  async create(actor: CreditTopupActor, body: unknown) {
    const scope = this.actor(actor), input = v.object(body); v.allowed(input, ['amount_paise']);
    const amount = input.amount_paise;
    v.requireInput(typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 100 && amount <= 100000000,
      'amount_paise must be a whole number between 100 and 100000000 (INR 1 to INR 1000000)');
    const key = actor.idempotencyKey;
    v.requireInput(typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(key), 'Provide a unique Idempotency-Key header (1 to 100 characters)');
    const configuration = provider.liveCreditConfiguration();
    const prepared = await db.transaction(async trx => {
      const user = await trx('users').where({ id: scope.user_id, company_id: scope.company_id, status: 'active' })
        .whereNull('deleted_at').first('id', 'role');
      // Some installations use a native enum without the legacy "company" role.
      // Check the returned role in application code so unknown enum literals never reach PostgreSQL.
      if (!user || !['admin', 'company'].includes(user.role)) throw new HTTP403Error({ message: 'Active company administrator required' });
      const company = await trx('companies').where({ id: scope.company_id, status: 'active' }).whereNull('deleted_at').forUpdate().first('id', 'settings');
      if (!company || company.settings?.organization_type === 'platform') throw new HTTP403Error({ message: 'An active customer company wallet is required' });
      const existing = await trx(orderTable).where({ ...scope, idempotency_key: key }).first();
      if (existing) {
        v.requireInput(existing.amount_paise === amount, 'Idempotency-Key was already used for a different amount');
        return { order: existing, replayed: true };
      }
      const [order] = await trx(orderTable).insert({ id: randomUUID(), ...scope, idempotency_key: key, amount_paise: amount,
        currency: 'INR', status: 'creating', provider_key_id: configuration.keyId,
        expires_at: new Date(Date.now() + 15 * 60000) }).returning('*');
      return { order, replayed: false };
    });
    if (prepared.replayed) return publicOrder(prepared.order);
    try {
      const qr = await provider.createCreditQr(prepared.order); this.checkQr(qr, prepared.order);
      const [updated] = await db(orderTable).where({ id: prepared.order.id, status: 'creating' })
        .update({ provider_qr_id: qr.id, qr_image_url: qr.image_url, status: 'pending', updated_at: db.fn.now() }).returning('*');
      if (!updated) return publicOrder(await db(orderTable).where({ id: prepared.order.id }).first());
      return publicOrder(updated);
    } catch {
      await db(orderTable).where({ id: prepared.order.id, status: 'creating' }).update({ status: 'creation_unknown', updated_at: db.fn.now() });
      throw new CustomError('QR creation could not be confirmed. Verify this same credit purchase to recover it; do not create another payment.', 503, true,
        { topup_id: prepared.order.id });
    }
  }

  private checkPayment(payment: any, order: any) {
    v.requireInput(payment?.entity === 'payment' && /^pay_[A-Za-z0-9]+$/.test(payment.id || '') &&
      paidStatuses.includes(payment.status) && payment.captured === true && payment.currency === 'INR' && payment.method === 'upi' &&
      payment.amount === order.amount_paise && (!order.provider_payment_id || order.provider_payment_id === payment.id) &&
      Number.isSafeInteger(payment.created_at) && payment.created_at > 0 &&
      Number.isSafeInteger(payment.amount_refunded) && payment.amount_refunded >= 0 && payment.amount_refunded <= payment.amount,
    'Razorpay has not confirmed a matching captured INR payment');
  }

  private async settle(orderId: string, payment: any) {
    const result = await db.transaction(async trx => {
      const order = await trx(orderTable).where({ id: orderId }).forUpdate().first();
      if (!order) throw new HTTP404Error({ message: 'Credit purchase not found' });
      this.checkPayment(payment, order);
      const company = await trx('companies').where({ id: order.company_id }).forUpdate().first();
      if (!company) throw new HTTP404Error({ message: 'Company wallet not found' });
      let balance = walletPaise(company.credit_balance), transactionId = order.ledger_transaction_id;
      const ledger = async (amount: number, type: 'credit' | 'debit', reference: string) => {
        const after = balance + amount;
        const [entry] = await trx('credit_transactions').insert({ company_id: order.company_id, company_name: company.name,
          type, amount: rupees(amount), balance_before: rupees(balance), balance_after: rupees(after),
          reference_type: reference, reference_id: order.id, created_by: order.user_id,
          description: `${type === 'credit' ? 'Razorpay credit purchase' : 'Razorpay payment refund'} ${payment.id}`,
          meta_data: JSON.stringify({ provider: 'razorpay', payment_id: payment.id, qr_code_id: order.provider_qr_id,
            currency: 'INR', amount_paise: Math.abs(amount) }) }).returning('id');
        balance = after; return entry.id;
      };
      if (!transactionId) transactionId = await ledger(payment.amount, 'credit', 'razorpay_topup');
      // Cumulative provider refund totals make duplicate and out-of-order events safe.
      const refunded = Math.max(order.refunded_amount_paise, payment.amount_refunded);
      if (refunded > order.refunded_amount_paise) await ledger(-(refunded - order.refunded_amount_paise), 'debit', 'razorpay_topup_refund');
      const status = refunded === payment.amount ? 'refunded' : refunded ? 'partially_refunded' : 'credited';
      await trx('companies').where({ id: company.id }).update({ credit_balance: rupees(balance), updated_at: trx.fn.now() });
      const [updated] = await trx(orderTable).where({ id: order.id }).update({ status,
        provider_payment_id: payment.id, paid_amount_paise: payment.amount, refunded_amount_paise: refunded,
        ledger_transaction_id: transactionId, paid_at: order.paid_at || new Date(payment.created_at * 1000),
        credited_at: order.credited_at || trx.fn.now(), last_checked_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
      if (!order.ledger_transaction_id || refunded > order.refunded_amount_paise) await trx('activity_logs').insert({
        user_id: order.user_id, company_id: order.company_id, action: 'CREATE', entity_type: 'CREDIT_TRANSACTION',
        entity_id: transactionId, description: `Razorpay credit purchase ${order.id}: ${status}`, status: 'SUCCESS', read: false,
        new_data: JSON.stringify({ topup_id: order.id, payment_id: payment.id, amount_paise: payment.amount, refunded_amount_paise: refunded }),
      });
      return publicOrder(updated);
    });
    markActivityRecorded(); return result;
  }

  private async verifyOrder(order: any) {
    provider.liveCreditConfiguration();
    if (order.provider_payment_id) {
      return this.settle(order.id, await provider.fetchCreditPayment(order.provider_payment_id));
    }
    let qr;
    if (order.provider_qr_id) qr = await provider.fetchCreditQr(order.provider_qr_id);
    else {
      qr = await provider.recoverCreditQr(order);
      if (!qr) return publicOrder(order);
    }
    this.checkQr(qr, order);
    const status = qr.status === 'closed' ? new Date(order.expires_at).getTime() <= Date.now() ? 'expired' : 'closed' : 'pending';
    // Do not regress an order that a concurrent webhook already credited.
    await db(orderTable).where({ id: order.id }).whereNull('ledger_transaction_id').update({
      provider_qr_id: qr.id, qr_image_url: qr.image_url, status, last_checked_at: db.fn.now(), updated_at: db.fn.now(),
    });
    const payments = await provider.fetchCreditQrPayments(qr.id);
    v.requireInput(Array.isArray(payments.items), 'Invalid Razorpay payment collection');
    const captured = payments.items.filter((item: any) => paidStatuses.includes(item.status) && item.captured === true);
    if (captured.length > 1) throw new CustomError('Multiple payments require reconciliation before crediting this wallet', 409);
    if (captured[0]) {
      this.checkPayment(captured[0], order);
      return this.settle(order.id, await provider.fetchCreditPayment(captured[0].id));
    }
    return publicOrder(await db(orderTable).where({ id: order.id }).first());
  }

  async verify(actor: CreditTopupActor, id: string, body: unknown = {}) {
    v.allowed(v.object(body), []);
    return this.verifyOrder(await this.find(actor, id));
  }

  async webhook(raw: Buffer | undefined, signature: unknown, eventId: unknown) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) throw new CustomError('Platform Razorpay webhook secret is not configured', 503);
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 1024 * 1024 || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature))
      throw new HTTP400Error({ message: 'Invalid Razorpay webhook signature' });
    const expected = createHmac('sha256', secret).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new HTTP400Error({ message: 'Invalid Razorpay webhook signature' });
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HTTP400Error({ message: 'Invalid Razorpay webhook JSON' }); }
    if (!['qr_code.credited', 'refund.processed'].includes(event.event)) return { ignored: true };
    const hash = createHash('sha256').update(raw).digest('hex');
    const eventKey = typeof eventId === 'string' && /^[A-Za-z0-9._:-]{1,150}$/.test(eventId) ? eventId : `sha256:${hash}`;
    const previous = await db('credit_topup_webhook_events').where({ id: eventKey }).first();
    if (previous) { v.requireInput(previous.payload_hash === hash, 'Webhook event ID reused with a different payload'); return { replayed: true }; }
    const qrId = event.payload?.qr_code?.entity?.id, paymentId = event.payload?.refund?.entity?.payment_id;
    let order;
    if (event.event === 'qr_code.credited' && typeof qrId === 'string') order = await db(orderTable).where({ provider_qr_id: qrId }).first();
    if (event.event === 'refund.processed' && typeof paymentId === 'string') order = await db(orderTable).where({ provider_payment_id: paymentId }).first();
    if (!order) return { ignored: true }; // Other platform payments and the shared reference QR are not tenant purchases.
    const result = await this.verifyOrder(order);
    if (!result.transaction_id) throw new CustomError('Captured payment is not visible yet. Retry the webhook.', 503);
    await db('credit_topup_webhook_events').insert({ id: eventKey, payload_hash: hash, topup_id: order.id, event: event.event })
      .onConflict('id').ignore();
    return { processed: true, topup_id: result.id, status: result.status };
  }
}

export default new CreditTopupService();
