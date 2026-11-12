import paymentPlans from './paymentPlan.service';
import planAddons, { walletPaise } from './planAddon.service';
import { Knex } from 'knex';
import { createHash, randomUUID } from 'crypto';
import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import CompanyPaymentModel from '../models/companyPayment.model';
import { encryptPaymentCredentials, decryptPaymentCredentials } from '../utils/paymentCredentials';
import { createGatewayOrder, verifyGatewayOrder, GatewayConnection, PaymentMode, createGatewayPaymentLink, fetchGatewayPaymentLink, paymentLinkCheckout, paymentLinkHasCapturedPayment } from './paymentGateway.provider';


export interface PaymentContext {
  userId?: string;
  companyId?: string;
  userRole?: string;
  /** Plan owner for team members (their plan belongs to the owner). */
  ownerId?: string;
  idempotencyKey?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ADDON_PACKS = 20;
const PLAN_LINK_FIELDS = ['mode', 'subscription_plan_id', 'user_id', 'customer_phone'];
const ADDON_LINK_FIELDS = ['mode', 'purchase_type', 'addon_id', 'user_plan_id', 'quantity', 'customer_phone'];

/** Orders whose payment unlocks something (a plan or add-on units) once paid. */
const needsFulfillment = (order: any) => order.purchase_type === 'addon' || Boolean(order.user_plan_id);

export function gatewayWebhookStatus(gateway: {
  id: string; provider: string; webhook_secret_configured?: boolean; webhook_verified_at?: Date | string | null;
}) {
  const applicable = gateway.provider === 'razorpay';
  const configured = applicable && Boolean(gateway.webhook_secret_configured);
  const verifiedAt = configured ? gateway.webhook_verified_at ?? null : null;
  return {
    webhook_verified: Boolean(verifiedAt),
    webhook_verified_at: verifiedAt,
    webhook_status: !applicable ? 'not_applicable' : !configured ? 'not_configured' : verifiedAt ? 'verified' : 'pending',
    webhook_path: applicable ? `/v1/webhooks/razorpay/company-payments/${gateway.id}` : null,
  };
}

export function paymentScope(req: PaymentContext, admin = false) {
  if (!req.companyId || !req.userId) throw new HTTP401Error({ message: 'Authenticated company context is required' });
  if (admin && !['admin', 'superadmin', 'company'].includes(req.userRole || '')) {
    throw new HTTP401Error({
      message: 'Only company administrators can manage payment gateways',
    });
  }
  return { company_id: req.companyId, user_id: req.userId };
}

export function paymentMode(value: unknown): PaymentMode {
  if (value !== 'test' && value !== 'live') throw new HTTP400Error({ message: 'mode must be test or live' });
  return value;
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HTTP400Error({ message: `${name} must be a non-empty string of at most ${max} characters` });
  }
  return value.trim();
}

export function paymentAmount(value: unknown): number {
  // Accept paise, not floating-point rupees, to avoid rounding money.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 100 || value > 100000000) {
    throw new HTTP400Error({ message: 'amount_paise must be an integer between 100 and 100000000 (INR)' });
  }
  return value;
}

function connection(gateway: any): GatewayConnection {
  return {
    provider: gateway.provider,
    mode: gateway.mode,
    credentials: decryptPaymentCredentials(gateway.credentials_encrypted, `${gateway.company_id}:${gateway.id}`),
  };
}

function publicOrder(order: any) {
  const checkout = typeof order.checkout === 'string' ? JSON.parse(order.checkout) : order.checkout;
  return {
    id: order.id,
    amount_paise: order.amount_paise,
    currency: order.currency,
    is_test: order.is_test,
    status: order.status,
    provider_order_id: order.provider_order_id,
    checkout,
    payment_flow: order.payment_flow ?? 'checkout',
    payment_link_id: order.provider_payment_link_id ?? null,
    payment_url: checkout?.payment_url ?? null,
    link_status: order.link_status ?? null,
    activation_status: order.is_test ? 'test_only' : !needsFulfillment(order) ? 'not_applicable' : order.fulfilled_at ? 'active' :
      order.status === 'paid' ? 'activation_pending' : 'awaiting_payment',
    fulfillment_error: order.fulfillment_error ?? null,
    created_at: order.created_at,
    paid_at: order.paid_at,
    purchase_type: order.purchase_type ?? 'plan',
    user_plan_id: order.user_plan_id ?? order.addon_user_plan_id ?? null,
    addon_id: order.addon_id ?? null,
    addon_quantity: order.addon_quantity ?? null,
    addon_purchase_id: order.addon_purchase_id ?? null,
    fulfilled_at: order.fulfilled_at ?? null,
  };
}

class CompanyPaymentService {
  providers() {
    return [
      {
        provider: 'razorpay',
        name: 'Razorpay',
        modes: ['test', 'live'],
        currency: 'INR',
        key_id_label: 'Key ID',
        key_secret_label: 'Key Secret',
      },
      {
        provider: 'cashfree',
        name: 'Cashfree',
        modes: ['test', 'live'],
        currency: 'INR',
        key_id_label: 'App ID',
        key_secret_label: 'Secret Key',
      },
    ];
  }

  async configure(req: PaymentContext, body: any, createOnly = false) {
    const { company_id } = paymentScope(req, true);
    const mode = paymentMode(body.mode);
    if (!['razorpay', 'cashfree'].includes(body.provider)) {
      throw new HTTP400Error({ message: 'provider must be razorpay or cashfree' });
    }
    const key_id = requiredString(body.key_id, 'key_id', 255);
    const key_secret = requiredString(body.key_secret, 'key_secret', 1024);
    if (body.provider === 'razorpay' && !key_id.startsWith(`rzp_${mode}_`)) {
      throw new HTTP400Error({ message: 'Razorpay key_id does not match the selected mode' });
    }
    const display_name = requiredString(body.display_name, 'display_name', 100);
    const webhook_secret = body.webhook_secret === undefined ? undefined : requiredString(body.webhook_secret, 'webhook_secret', 1024);
    if (webhook_secret && body.provider !== 'razorpay') throw new HTTP400Error({ message: 'webhook_secret is supported for Razorpay only' });
    const id = randomUUID();
    const credentials_encrypted = encryptPaymentCredentials({ key_id, key_secret, ...(webhook_secret ? { webhook_secret } : {}) }, `${company_id}:${id}`);
    await db.transaction(async (trx) => {
      // Serialize configuration changes and order creation for this company.
      const company = await CompanyPaymentModel.lockCompany(trx, company_id);
      if (!company) throw new HTTP404Error({ message: 'Company not found' });
      // Check under the company lock so concurrent POSTs cannot replace each other.
      if (createOnly && await CompanyPaymentModel.activeGateway(trx, company_id, mode)) {
        throw new HTTP400Error({ message: `A ${mode} payment gateway already exists. Use PUT /gateways to replace it.` });
      }
      await CompanyPaymentModel.deactivateGateways(trx, company_id, mode);
      await CompanyPaymentModel.insertGateway(trx, {
        id,
        company_id,
        provider: body.provider,
        mode,
        display_name,
        credentials_encrypted,
        webhook_secret_configured: Boolean(webhook_secret),
      });
    });
    return { id, provider: body.provider, mode, display_name, active: true, credentials_configured: true,
      webhook_secret_configured: Boolean(webhook_secret),
      ...gatewayWebhookStatus({ id, provider: body.provider, webhook_secret_configured: Boolean(webhook_secret) }) };
  }

  async configurations(req: PaymentContext) {
    const { company_id } = paymentScope(req, true);
    const gateways = await CompanyPaymentModel.activeConfigurations(company_id);
    return gateways.map(gateway => ({ ...gateway, ...gatewayWebhookStatus(gateway) }));
  }

  async disable(req: PaymentContext, modeInput: unknown) {
    const { company_id } = paymentScope(req, true);
    const mode = paymentMode(modeInput);
    await db.transaction(async (trx) => {
      await CompanyPaymentModel.lockCompany(trx, company_id);
      await CompanyPaymentModel.deactivateGateways(trx, company_id, mode);
    });
    return { mode, active: false };
  }

  async createPaymentLink(req: PaymentContext, body: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HTTP400Error({ message: 'A JSON object body is required' });
    }
    if (body.purchase_type === 'addon') {
      if (Object.keys(body).some(key => !ADDON_LINK_FIELDS.includes(key))) {
        throw new HTTP400Error({ message: `Only ${ADDON_LINK_FIELDS.join(', ')} are accepted for an add-on payment link` });
      }
      return this.create(req, { ...body, mode: body.mode ?? 'live' }, false, true);
    }
    if (body.purchase_type !== undefined && body.purchase_type !== 'plan') {
      throw new HTTP400Error({ message: 'purchase_type must be plan or addon' });
    }
    const { purchase_type: _type, ...planBody } = body;
    if (Object.keys(planBody).some(key => !PLAN_LINK_FIELDS.includes(key))) {
      throw new HTTP400Error({ message: 'Only mode, subscription_plan_id, user_id and customer_phone are accepted' });
    }
    if (!planBody.subscription_plan_id) throw new HTTP400Error({ message: 'subscription_plan_id is required for a plan payment link' });
    return this.create(req, { ...planBody, mode: planBody.mode ?? 'live' }, false, true);
  }

  /** Validates the add-on part of a payment-link request. Price is never taken from the client. */
  private addonRequest(body: any, paymentLink: boolean) {
    if (body.purchase_type === undefined) return null;
    if (body.purchase_type !== 'addon' || !paymentLink) {
      throw new HTTP400Error({ message: 'Add-on purchases are only supported through payment links' });
    }
    if (typeof body.addon_id !== 'string' || !UUID.test(body.addon_id) ||
      typeof body.user_plan_id !== 'string' || !UUID.test(body.user_plan_id)) {
      throw new HTTP400Error({ message: 'addon_id and user_plan_id must be UUIDs' });
    }
    const quantity = body.quantity ?? 1;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ADDON_PACKS) {
      throw new HTTP400Error({ message: `quantity must be an integer between 1 and ${MAX_ADDON_PACKS}` });
    }
    if (body.amount_paise !== undefined) throw new HTTP400Error({ message: 'Omit amount_paise; add-on price comes from the catalog' });
    return { addonId: body.addon_id as string, userPlanId: body.user_plan_id as string, quantity };
  }

  /** Prices an add-on link and checks the buyer may top up this plan. Runs under the company lock. */
  private async quoteAddon(trx: Knex.Transaction, req: PaymentContext, companyId: string,
    request: { addonId: string; userPlanId: string; quantity: number }) {
    const { plan, quote } = await planAddons.quote(trx, { companyId, ...request });
    const owner = req.ownerId ?? req.userId;
    if (plan.user_id !== owner && !['admin', 'superadmin', 'company'].includes(req.userRole || '')) {
      throw new HTTP401Error({ message: 'You can only buy add-ons for your own plan' });
    }
    if (quote.total_price_paise < 100) {
      throw new HTTP400Error({ message: 'This add-on costs less than INR 1 and cannot be paid online' });
    }
    // Same early check as plan purchases: the platform fee is taken from the company
    // wallet when the payment is fulfilled, so do not let the customer pay if it can't be.
    const company = await trx('companies').where({ id: companyId }).first();
    if (walletPaise(company?.credit_balance ?? 0) < quote.platform_fee_paise) {
      throw new HTTP400Error({
        message: 'Not enough credits. Please ask your administrator.',
        details: { code: 'INSUFFICIENT_COMPANY_CREDITS', required_platform_fee_paise: quote.platform_fee_paise },
      });
    }
    return quote;
  }

  /** Activates whatever a paid order bought. Caller holds the order row lock. */
  private async fulfill(trx: Knex.Transaction, order: any) {
    if (order.purchase_type === 'addon') return planAddons.fulfillOrder(trx, order);
    return paymentPlans.fulfill(trx, order);
  }

  async create(req: PaymentContext, body: any, test = false, paymentLink = false) {
    const scope = paymentScope(req);
    if (!['admin', 'superadmin', 'company', 'user'].includes(req.userRole || '')) {
      throw new HTTP401Error({ message: 'A company user is required to create a payment purchase' });
    }
    const mode = test ? 'test' : paymentMode(body.mode);
    if (test && body.mode !== undefined && body.mode !== 'test') {
      throw new HTTP400Error({ message: 'The test endpoint only accepts test mode' });
    }
    if (test && body.amount_paise !== undefined && body.amount_paise !== 100) {
      throw new HTTP400Error({ message: 'Test orders use a fixed amount_paise of 100 (INR 1)' });
    }
    const addon = this.addonRequest(body, paymentLink);
    if (addon && (body.subscription_plan_id !== undefined || body.user_id !== undefined)) {
      throw new HTTP400Error({ message: 'An add-on payment link cannot also include subscription_plan_id or user_id' });
    }
    const planId = body.subscription_plan_id;
    const recipientId = body.user_id ?? scope.user_id;
    if (recipientId !== scope.user_id && !['admin', 'superadmin', 'company'].includes(req.userRole || '')) {
      throw new HTTP401Error({ message: 'Only company administrators can purchase for another user' });
    }
    if (planId !== undefined) {
      if (typeof planId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(planId) || typeof recipientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recipientId)) {
        throw new HTTP400Error({ message: 'subscription_plan_id and user_id must be UUIDs' });
      }
      if (mode !== 'live' && !paymentLink) throw new HTTP400Error({ message: 'Subscription purchases require live mode; test payments cannot activate plans' });
      if (body.amount_paise !== undefined) throw new HTTP400Error({ message: 'Omit amount_paise for subscriptions; price comes from the saved plan' });
    } else if (body.user_id !== undefined) throw new HTTP400Error({ message: 'user_id is only supported for subscription purchases' });
    const requestedAmount = planId === undefined && !addon ? (test ? 100 : paymentAmount(body.amount_paise)) : null;
    const idempotency_key = requiredString(req.idempotencyKey, 'Idempotency-Key header', 100);
    const customer_phone =
      body.customer_phone === undefined ? '' : requiredString(body.customer_phone, 'customer_phone', 15);
    if (customer_phone && !/^\d{10}$/.test(customer_phone)) {
      throw new HTTP400Error({ message: 'customer_phone must contain 10 digits for this INR checkout' });
    }
    const request_hash = createHash('sha256')
      .update(JSON.stringify(addon
        ? { mode, purchase_type: 'addon', addon_id: addon.addonId, user_plan_id: addon.userPlanId, quantity: addon.quantity, customer_phone, payment_flow: 'link' }
        : planId === undefined ? { mode, amount_paise: requestedAmount, customer_phone } : { mode, subscription_plan_id: planId, user_id: recipientId, customer_phone,
        ...(paymentLink ? { payment_flow: 'link' } : {}) }))
      .digest('hex');
    const prepared = await db.transaction(async (trx) => {
      const company = await CompanyPaymentModel.lockCompany(trx, scope.company_id);
      if (!company) throw new HTTP404Error({ message: 'Company not found' });
      const existing = await CompanyPaymentModel.findExistingOrder(trx, scope, idempotency_key);
      if (existing) {
        if (existing.request_hash !== request_hash)
          throw new HTTP400Error({ message: 'Idempotency-Key was already used with a different payment request' });
        return { existing };
      }
      const gateway = await CompanyPaymentModel.activeGateway(trx, scope.company_id, mode);
      if (!gateway) throw new HTTP400Error({ message: `Configure a ${mode} payment gateway for this company first` });
      if (paymentLink && (gateway.provider !== 'razorpay' || !gateway.webhook_secret_configured)) {
        throw new HTTP400Error({ message: 'Configure a Razorpay gateway with webhook_secret before creating payment links' });
      }
      if (gateway.provider === 'cashfree' && !customer_phone) {
        throw new HTTP400Error({ message: 'customer_phone is required for Cashfree checkout' });
      }
      const addonQuote = addon ? await this.quoteAddon(trx, req, scope.company_id, addon) : null;
      const reserved = planId === undefined ? null : await paymentPlans.reserve(trx, scope.company_id, recipientId, planId);
      const amount_paise = addonQuote?.total_price_paise ?? reserved?.amount ?? requestedAmount!;
      const gatewayConnection = connection(gateway);
      const id = randomUUID();
      const order = await CompanyPaymentModel.insertOrder(trx, {
        id,
        ...scope,
        gateway_id: gateway.id,
        idempotency_key,
        request_hash,
        amount_paise,
        currency: 'INR',
        is_test: mode === 'test',
        status: 'creating',
        ...(reserved ? { user_plan_id: reserved.userPlanId } : {}),
        ...(addon ? {
          purchase_type: 'addon',
          addon_id: addon.addonId,
          addon_user_plan_id: addon.userPlanId,
          addon_quantity: addon.quantity,
        } : {}),
        ...(paymentLink ? { payment_flow: 'link', next_check_at: new Date(Date.now() + 60000) } : {}),
      });
      return { gateway, gatewayConnection, order };
    });
    if (prepared.existing) return publicOrder(prepared.existing);
    const { order, gateway, gatewayConnection } = prepared;
    try {
      if (paymentLink) {
        const link = await createGatewayPaymentLink(gatewayConnection!, {
          ...order,
          customer_phone,
          description: addon ? 'Plan add-on purchase' : 'Subscription plan purchase',
        });
        // A webhook/reconciler may already have processed this purchase. Lock and
        // merge metadata without regressing its paid/fulfilled state.
        await db.transaction(async trx => {
          const locked = await trx('company_payment_orders').where({ id: order.id }).forUpdate().first();
          if (locked.provider_payment_link_id && locked.provider_payment_link_id !== link.id) {
            throw new HTTP400Error({ message: 'Payment link identity changed; reconcile this purchase' });
          }
          await trx('company_payment_orders').where({ id: order.id }).update({
            provider_payment_link_id: link.id,
            checkout: JSON.stringify(paymentLinkCheckout(gatewayConnection!, link)),
            status: locked.status === 'paid' ? 'paid' : 'pending',
            link_status: locked.link_status ?? link.status,
            updated_at: new Date(),
          });
        });
        return this.get(req, order.id);
      }
      const result = await createGatewayOrder(gatewayConnection!, {
        ...order,
        customer_phone,
        display_name: gateway.display_name,
      });
      const updated = await CompanyPaymentModel.updateOrder(scope, order.id, {
        provider_order_id: result.provider_order_id,
        checkout: JSON.stringify(result.checkout),
        status: 'pending',
        updated_at: new Date(),
      });
      return publicOrder(updated);
    } catch (error) {
      // A timeout may still have created an external order. Do not retry POST automatically.
      await db('company_payment_orders').where({ id: order.id, ...scope, status: 'creating' })
        .update({ status: 'creation_unknown', updated_at: new Date() });
      if (paymentLink) return this.get(req, order.id);
      throw error;
    }
  }

  private async findOrder(req: PaymentContext, id: string) {
    const { company_id, user_id } = paymentScope(req);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new HTTP400Error({ message: 'Invalid payment order id' });
    }
    const canViewCompany = ['admin', 'superadmin', 'company'].includes(req.userRole || '');
    const order = await CompanyPaymentModel.findOrder(company_id, id, canViewCompany ? undefined : user_id);
    if (!order) throw new HTTP404Error({ message: 'Payment order not found' });
    return order;
  }

  async get(req: PaymentContext, id: string) {
    return publicOrder(await this.findOrder(req, id));
  }

  async verify(req: PaymentContext, id: string) {
    const order = await this.findOrder(req, id);
    if (order.status === 'paid' && (!needsFulfillment(order) || order.fulfilled_at || order.is_test)) return publicOrder(order);
    if (order.payment_flow === 'link') return this.verifyPaymentLink(req, order);
    if (!order.provider_order_id)
      throw new HTTP400Error({
        message:
          'Order creation is incomplete. Reconcile it with the gateway dashboard using the local order id before retrying.',
      });
    const gateway = await CompanyPaymentModel.findGateway(order.company_id, order.gateway_id);
    if (!gateway) throw new HTTP404Error({ message: 'Order gateway configuration not found' });
    const paid = await verifyGatewayOrder(connection(gateway), order);
    if (paid) {
      // Payment confirmation and entitlement activation commit together. Retrying
      // verification after a failure is safe and cannot extend the plan twice.
      await db.transaction(async trx => {
        const locked = await trx('company_payment_orders').where({ id, company_id: order.company_id }).forUpdate().first();
        if (!locked) throw new HTTP404Error({ message: 'Payment order not found' });
        await this.fulfill(trx, locked);
        if (locked.status !== 'paid') await trx('company_payment_orders').where({ id }).update({ status: 'paid', paid_at: new Date(), updated_at: new Date() });
      });
    }
    // Read back the latest state so concurrent verifications never regress paid to pending.
    return this.get(req, id);
  }

  private async verifyPaymentLink(req: PaymentContext, order: any) {
    const gateway = await CompanyPaymentModel.findGateway(order.company_id, order.gateway_id);
    if (!gateway) throw new HTTP404Error({ message: 'Order gateway configuration not found' });
    const link = await fetchGatewayPaymentLink(connection(gateway), order);
    if (!link) return this.get(req, order.id);
    const paid = link.status === 'paid' && link.amount_paid === order.amount_paise;
    await db.transaction(async trx => {
      const locked = await trx('company_payment_orders').where({ id: order.id, company_id: order.company_id }).forUpdate().first();
      if (locked.provider_payment_link_id && locked.provider_payment_link_id !== link.id) {
        throw new HTTP400Error({ message: 'Payment link identity changed; reconcile this purchase' });
      }
      if (locked.status === 'paid') return;
      await trx('company_payment_orders').where({ id: order.id }).update({
        provider_payment_link_id: link.id,
        checkout: JSON.stringify(paymentLinkCheckout(connection(gateway), link)),
        link_status: link.status, status: paid ? 'paid' : 'pending',
        ...(paid ? { paid_at: new Date() } : {}),
        last_checked_at: new Date(), updated_at: new Date(),
        next_check_at: ['cancelled', 'expired'].includes(link.status) ? null : new Date(Date.now() + 60000),
      });
    });
    // Record receipt independently so a wallet/activation failure never asks a
    // customer to pay again. Fulfillment itself remains a single transaction.
    if (paid) {
      try {
        if (!await paymentLinkHasCapturedPayment(connection(gateway), link, order)) {
          await db('company_payment_orders').where({ id: order.id }).whereNull('fulfilled_at')
            .update({ fulfillment_error: 'PAYMENT_CAPTURE_REVIEW_REQUIRED', next_check_at: new Date(Date.now() + 300000) });
          return this.get(req, order.id);
        }
        await db.transaction(async trx => {
          const locked = await trx('company_payment_orders').where({ id: order.id, company_id: order.company_id }).forUpdate().first();
          await this.fulfill(trx, locked);
          await trx('company_payment_orders').where({ id: order.id }).update({ fulfillment_error: null, next_check_at: null });
        });
      } catch {
        await db('company_payment_orders').where({ id: order.id }).whereNull('fulfilled_at')
          .update({ fulfillment_error: 'PLAN_ACTIVATION_PENDING', next_check_at: new Date(Date.now() + 60000) });
      }
    }
    return this.get(req, order.id);
  }
}

export default new CompanyPaymentService();
