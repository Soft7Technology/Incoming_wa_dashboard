import { createHash } from 'crypto';
import { Knex } from 'knex';
import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CatalogActor, positiveInt, textField } from './planCatalog.service';
import { isUnmeteredFeature, storedAddonLimit } from '../utils/planFeatures';
import { addonPrice } from '../utils/addonPricing';

export function walletPaise(value: unknown): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new HTTP400Error({ message: 'Invalid wallet balance' });
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new HTTP400Error({ message: 'Invalid wallet balance' });
  return amount;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AddonPurchaseInput {
  companyId: string;
  /** user who owns the plan and receives the units */
  userId: string;
  userPlanId: string;
  addonId: string;
  quantity: number;
  /** user recorded as the buyer */
  purchasedBy: string;
  idempotencyKey: string;
}

interface ApplyOptions {
  /** Razorpay-paid purchases: the customer price that was actually paid. */
  expectedTotalPaise?: number;
  /** Mark wallet errors as "payment already received" so the customer is not asked to pay again. */
  paymentReceived?: boolean;
}

// Same hash shape as before the refactor so existing idempotency records still match.
const purchaseHash = (input: AddonPurchaseInput) =>
  createHash('sha256')
    .update(JSON.stringify({ userId: input.userId, addonId: input.addonId, planId: input.userPlanId, quantity: input.quantity }))
    .digest('hex');

class PlanAddonService {
  /** Admin purchase paid from the company wallet. */
  async purchase(actor: CatalogActor, body: any, key: unknown) {
    if (!actor.userId || !actor.companyId || !['admin', 'company', 'superadmin'].includes(actor.userRole || '')) {
      throw new HTTP403Error({ message: 'A company administrator is required to buy add-ons' });
    }
    const userId = textField(body.user_id, 'user_id', 36);
    const addonId = textField(body.addon_id, 'addon_id', 36);
    const planId = textField(body.user_plan_id, 'user_plan_id', 36);
    for (const id of [userId, addonId, planId]) {
      if (!UUID.test(id)) throw new HTTP400Error({ message: 'user_id, user_plan_id and addon_id must be UUIDs' });
    }
    const quantity = positiveInt(body.quantity ?? 1, 'quantity', 10000);
    if (Object.keys(body).some((field) => !['user_id', 'user_plan_id', 'addon_id', 'quantity'].includes(field))) {
      throw new HTTP400Error({
        message:
          'Only user_id, user_plan_id, addon_id and quantity are accepted; price and capacity come from the catalog',
      });
    }
    const idempotencyKey = textField(key, 'Idempotency-Key', 100);
    const companyId = actor.companyId;
    const purchasedBy = actor.userId;
    return db.transaction((trx) =>
      this.apply(trx, { companyId, userId, userPlanId: planId, addonId, quantity, purchasedBy, idempotencyKey }),
    );
  }

  /**
   * Validates a purchase against the plan and catalog without writing anything.
   * Used to price a Razorpay payment link before the customer pays.
   */
  async quote(trx: Knex.Transaction, input: Pick<AddonPurchaseInput, 'companyId' | 'userPlanId' | 'addonId' | 'quantity'>) {
    const plan = await trx('user_plans').where({ id: input.userPlanId, company_id: input.companyId }).first();
    if (!plan) throw new HTTP400Error({ message: 'The selected user plan is inactive, expired, or has been replaced' });
    const result = await this.evaluate(trx, input, plan);
    return { ...result, plan };
  }

  /** Completes a paid Razorpay add-on order exactly once. The caller locks the order row. */
  async fulfillOrder(trx: Knex.Transaction, order: any) {
    if (order.purchase_type !== 'addon' || order.fulfilled_at || order.is_test) return;
    const plan = await trx('user_plans').where({ id: order.addon_user_plan_id, company_id: order.company_id }).first();
    if (!plan) throw new HTTP400Error({ message: 'The plan for this add-on purchase no longer exists' });
    const purchase = await this.apply(
      trx,
      {
        companyId: order.company_id,
        userId: plan.user_id,
        userPlanId: plan.id,
        addonId: order.addon_id,
        quantity: Number(order.addon_quantity),
        purchasedBy: order.user_id,
        idempotencyKey: `payment-order:${order.id}`,
      },
      { expectedTotalPaise: Number(order.amount_paise), paymentReceived: true },
    );
    await trx('company_payment_orders')
      .where({ id: order.id })
      .update({ fulfilled_at: new Date(), addon_purchase_id: purchase.id });
  }

  /** Plan, catalog and capacity checks shared by quoting and applying. */
  private async evaluate(
    trx: Knex.Transaction,
    input: Pick<AddonPurchaseInput, 'companyId' | 'addonId' | 'quantity'>,
    plan: any,
  ) {
    const now = new Date();
    if (!plan || !plan.active || !(new Date(plan.start_date) <= now && now < new Date(plan.end_date))) {
      throw new HTTP400Error({ message: 'The selected user plan is inactive, expired, or has been replaced' });
    }
    if (plan.billing_cycle === 'Free') throw new HTTP400Error({ message: 'Add-ons require a paid plan' });
    // Saved plan selections are assignment defaults. Later purchases use the
    // current pack availability and the assigned plan's feature capacity.
    const addon = await trx('plan_addons').where({ id: input.addonId, active: true }).forShare().first();
    if (!addon) throw new HTTP400Error({ message: 'Add-on is unavailable' });
    if (addon.company_id != null && addon.company_id !== input.companyId) throw new HTTP404Error({ message: 'Add-on is unavailable in your company' });
    if (isUnmeteredFeature(addon.feature_key)) throw new HTTP400Error({ message: 'Tags, messages and custom columns are unlimited; no add-on purchase is required' });
    const feature = await trx('plan_features')
      .where({ key: addon.feature_key, active: true, addon_allowed: true })
      .first();
    if (!feature) throw new HTTP400Error({ message: 'Feature does not allow add-ons' });
    const limits = typeof plan.limits === 'string' ? JSON.parse(plan.limits) : { ...plan.limits };
    const limit = limits[addon.feature_key];
    if (!limit || limit.enabled === false || limit.limit === null || limit.limit === undefined) {
      throw new HTTP400Error({ message: 'Add-ons require an included feature with a finite base limit' });
    }
    positiveInt(Number(addon.units), 'saved add-on units', 2147483647);
    positiveInt(Number(addon.price_paise), 'saved add-on price');
    const units = Number(addon.units) * input.quantity;
    const pricing = await trx('company_addon_pricing').where({ company_id: input.companyId, addon_id: addon.id }).first();
    const quote = addonPrice(addon, Number(pricing?.markup_paise ?? 0), input.quantity);
    const existingBonus = storedAddonLimit(limit.addon_limit);
    if (!Number.isSafeInteger(existingBonus))
      throw new HTTP400Error({ message: 'Invalid existing add-on limit' });
    const bonus = existingBonus + units;
    if (
      !Number.isSafeInteger(bonus) ||
      bonus < 0 ||
      !Number.isSafeInteger(Number(limit.limit)) ||
      Number(limit.limit) < 0 ||
      !Number.isSafeInteger(Number(limit.limit) + bonus) ||
      !Number.isSafeInteger(quote.platform_fee_paise)
    ) {
      throw new HTTP400Error({ message: 'Add-on exceeds supported limits' });
    }
    return { addon, limits, limit, units, bonus, quote };
  }

  /**
   * Applies the units to the plan and moves the platform fee from the company
   * wallet to the platform wallet. Idempotent per (company, idempotencyKey).
   */
  private async apply(trx: Knex.Transaction, input: AddonPurchaseInput, options: ApplyOptions = {}) {
    const hash = purchaseHash(input);
    const recipient = await trx('users').where({ role: 'superadmin' }).whereNull('deleted_at').orderBy('id').first();
    if (!recipient) throw new HTTP400Error({ message: 'Platform wallet recipient is not configured' });
    // Match plan assignment's lock order: users in ID order, then plan, then company.
    const users = await trx('users').whereIn('id', [input.userId, recipient.id]).orderBy('id').forUpdate();
    const user = users.find((row) => row.id === input.userId && row.company_id === input.companyId && !row.deleted_at);
    const platform = users.find((row) => row.id === recipient.id && row.role === 'superadmin' && !row.deleted_at);
    if (!user || user.role === 'superadmin')
      throw new HTTP404Error({ message: 'Add-on recipient must be a user in your company' });
    if (!platform) throw new HTTP400Error({ message: 'Platform wallet recipient is unavailable' });
    const plan = await trx('user_plans')
      .where({ id: input.userPlanId, user_id: input.userId, company_id: input.companyId })
      .forUpdate()
      .first();
    const company = await trx('companies').where({ id: input.companyId }).forUpdate().first();
    if (!company) throw new HTTP404Error({ message: 'Company not found' });
    const existing = await trx('user_plan_addons')
      .where({ company_id: input.companyId, idempotency_key: input.idempotencyKey })
      .first();
    if (existing) {
      if (existing.request_hash !== hash)
        throw new HTTP400Error({ message: 'Idempotency-Key was used for a different add-on purchase' });
      return existing;
    }
    const { addon, limits, limit, units, bonus, quote } = await this.evaluate(trx, input, plan);
    if (options.expectedTotalPaise !== undefined && quote.total_price_paise !== options.expectedTotalPaise) {
      throw new HTTP400Error({
        message: 'Add-on price changed after payment; reconcile this purchase before applying it',
        details: { payment_received: true },
      });
    }
    const amount = quote.platform_fee_paise;
    const before = walletPaise(company.credit_balance);
    const platformBefore = walletPaise(platform.credit_balance ?? 0);
    if (before < amount)
      throw new HTTP400Error({
        message: options.paymentReceived
          ? 'Not enough credits. Please ask your administrator. Top up and verify the same order again; do not pay again.'
          : 'Not enough credits. Please ask your administrator.',
        details: {
          code: 'INSUFFICIENT_COMPANY_CREDITS',
          required_platform_fee_paise: amount,
          ...(options.paymentReceived ? { payment_received: true } : {}),
        },
      });
    if (!Number.isSafeInteger(platformBefore + amount))
      throw new HTTP400Error({ message: 'Platform wallet exceeds supported balance' });
    const [purchase] = await trx('user_plan_addons')
      .insert({
        company_id: input.companyId,
        user_id: input.userId,
        user_plan_id: plan.id,
        addon_id: addon.id,
        purchased_by: input.purchasedBy,
        idempotency_key: input.idempotencyKey,
        request_hash: hash,
        feature_key: addon.feature_key,
        quantity: input.quantity,
        units,
        amount_paise: amount,
        ...quote,
        expires_at: plan.end_date,
      })
      .returning('*');
    await trx('companies')
      .where({ id: company.id })
      .update({ credit_balance: (before - amount) / 100 });
    await trx('users')
      .where({ id: platform.id })
      .update({ credit_balance: (platformBefore + amount) / 100 });
    limits[addon.feature_key] = { ...limit, addon_limit: bonus };
    await trx('user_plans')
      .where({ id: plan.id })
      .update({ limits: JSON.stringify(limits) });
    await trx('credit_transactions').insert([
      {
        company_id: company.id,
        user_id: input.userId,
        type: 'debit',
        amount: -amount / 100,
        balance_before: before / 100,
        balance_after: (before - amount) / 100,
        created_by: input.purchasedBy,
        reference_type: 'plan_addon',
        reference_id: purchase.id,
        description: `Add-on ${addon.name}; purchase ${purchase.id}`,
      },
      {
        company_id: platform.company_id,
        user_id: platform.id,
        type: 'credit',
        amount: amount / 100,
        balance_before: platformBefore / 100,
        balance_after: (platformBefore + amount) / 100,
        created_by: input.purchasedBy,
        reference_type: 'plan_addon',
        reference_id: purchase.id,
        description: `Add-on from ${company.id}; purchase ${purchase.id}`,
      },
    ]);
    await trx('activity_logs').insert({
      company_id: company.id,
      user_id: input.purchasedBy,
      action: 'CREATE',
      entity_type: 'SUBSCRIPTION',
      entity_id: plan.id,
      read: false,
      status: 'SUCCESS',
      description: `Purchased ${input.quantity} x ${addon.name} for user ${input.userId}`,
      new_data: JSON.stringify({
        purchase_id: purchase.id,
        feature_key: addon.feature_key,
        units,
        amount_paise: amount,
        ...quote,
      }),
    });
    return purchase;
  }
}
export default new PlanAddonService();
