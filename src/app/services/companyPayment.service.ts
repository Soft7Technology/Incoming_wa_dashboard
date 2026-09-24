import { createHash, randomUUID } from 'crypto';
import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import CompanyPaymentModel from '../models/companyPayment.model';

export interface PaymentContext {
  userId?: string;
  companyId?: string;
  userRole?: string;
  idempotencyKey?: string;
}
import { encryptPaymentCredentials, decryptPaymentCredentials } from '../utils/paymentCredentials';
import { createGatewayOrder, verifyGatewayOrder, GatewayConnection, PaymentMode } from './paymentGateway.provider';

export function paymentScope(req: PaymentContext, admin = false) {
  if (!req.companyId || !req.userId) throw new HTTP401Error({ message: 'Authenticated company context is required' });
  if (admin && !['admin', 'superadmin', 'company'].includes(req.userRole || '')) {
    throw new HTTP401Error({
      message: 'Only company administrators can manage payment gateways and create payment orders',
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
  return {
    id: order.id,
    amount_paise: order.amount_paise,
    currency: order.currency,
    is_test: order.is_test,
    status: order.status,
    provider_order_id: order.provider_order_id,
    checkout: order.checkout,
    created_at: order.created_at,
    paid_at: order.paid_at,
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

  async configure(req: PaymentContext, body: any) {
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
    const id = randomUUID();
    const credentials_encrypted = encryptPaymentCredentials({ key_id, key_secret }, `${company_id}:${id}`);
    await db.transaction(async (trx) => {
      // Serialize configuration changes and order creation for this company.
      const company = await CompanyPaymentModel.lockCompany(trx, company_id);
      if (!company) throw new HTTP404Error({ message: 'Company not found' });
      await CompanyPaymentModel.deactivateGateways(trx, company_id, mode);
      await CompanyPaymentModel.insertGateway(trx, {
        id,
        company_id,
        provider: body.provider,
        mode,
        display_name,
        credentials_encrypted,
      });
    });
    return { id, provider: body.provider, mode, display_name, active: true, credentials_configured: true };
  }

  async configurations(req: PaymentContext) {
    const { company_id } = paymentScope(req, true);
    return CompanyPaymentModel.activeConfigurations(company_id);
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

  async create(req: PaymentContext, body: any, test = false) {
    const scope = paymentScope(req, true);
    const mode = test ? 'test' : paymentMode(body.mode);
    if (test && body.mode !== undefined && body.mode !== 'test') {
      throw new HTTP400Error({ message: 'The test endpoint only accepts test mode' });
    }
    if (test && body.amount_paise !== undefined && body.amount_paise !== 100) {
      throw new HTTP400Error({ message: 'Test orders use a fixed amount_paise of 100 (INR 1)' });
    }
    const amount_paise = test ? 100 : paymentAmount(body.amount_paise);
    const idempotency_key = requiredString(req.idempotencyKey, 'Idempotency-Key header', 100);
    const customer_phone =
      body.customer_phone === undefined ? '' : requiredString(body.customer_phone, 'customer_phone', 15);
    if (customer_phone && !/^\d{10}$/.test(customer_phone)) {
      throw new HTTP400Error({ message: 'customer_phone must contain 10 digits for this INR checkout' });
    }
    const request_hash = createHash('sha256')
      .update(JSON.stringify({ mode, amount_paise, customer_phone }))
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
      if (gateway.provider === 'cashfree' && !customer_phone) {
        throw new HTTP400Error({ message: 'customer_phone is required for Cashfree checkout' });
      }
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
      });
      return { gateway, gatewayConnection, order };
    });
    if (prepared.existing) return publicOrder(prepared.existing);
    const { order, gateway, gatewayConnection } = prepared;
    try {
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
      await CompanyPaymentModel.updateOrder(scope, order.id, { status: 'creation_unknown', updated_at: new Date() });
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
    if (order.status === 'paid') return publicOrder(order);
    if (!order.provider_order_id)
      throw new HTTP400Error({
        message:
          'Order creation is incomplete. Reconcile it with the gateway dashboard using the local order id before retrying.',
      });
    const gateway = await CompanyPaymentModel.findGateway(order.company_id, order.gateway_id);
    if (!gateway) throw new HTTP404Error({ message: 'Order gateway configuration not found' });
    const paid = await verifyGatewayOrder(connection(gateway), order);
    if (paid) {
      await CompanyPaymentModel.markPaid(order.company_id, id);
    }
    // Read back the latest state so concurrent verifications never regress paid to pending.
    return this.get(req, id);
  }
}

export default new CompanyPaymentService();
