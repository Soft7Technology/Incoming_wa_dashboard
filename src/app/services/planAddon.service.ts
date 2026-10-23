import { createHash } from 'crypto';
import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CatalogActor, positiveInt, textField } from './planCatalog.service';
import { isUnmeteredFeature, snapshotPlanAddons, storedAddonLimit } from '../utils/planFeatures';

export function walletPaise(value: unknown): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new HTTP400Error({ message: 'Invalid wallet balance' });
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new HTTP400Error({ message: 'Invalid wallet balance' });
  return amount;
}

class PlanAddonService {
  async purchase(actor: CatalogActor, body: any, key: unknown) {
    if (!actor.userId || !actor.companyId || !['admin', 'company', 'superadmin'].includes(actor.userRole || '')) {
      throw new HTTP403Error({ message: 'A company administrator is required to buy add-ons' });
    }
    const userId = textField(body.user_id, 'user_id', 36);
    const addonId = textField(body.addon_id, 'addon_id', 36);
    const planId = textField(body.user_plan_id, 'user_plan_id', 36);
    for (const id of [userId, addonId, planId]) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        throw new HTTP400Error({ message: 'user_id, user_plan_id and addon_id must be UUIDs' });
    }
    const quantity = positiveInt(body.quantity ?? 1, 'quantity', 10000);
    if (Object.keys(body).some((field) => !['user_id', 'user_plan_id', 'addon_id', 'quantity'].includes(field))) {
      throw new HTTP400Error({
        message:
          'Only user_id, user_plan_id, addon_id and quantity are accepted; price and capacity come from the catalog',
      });
    }
    const idempotencyKey = textField(key, 'Idempotency-Key', 100);
    const hash = createHash('sha256').update(JSON.stringify({ userId, addonId, planId, quantity })).digest('hex');
    return db.transaction(async (trx) => {
      const recipient = await trx('users').where({ role: 'superadmin' }).whereNull('deleted_at').orderBy('id').first();
      if (!recipient) throw new HTTP400Error({ message: 'Platform wallet recipient is not configured' });
      // Match plan assignment's lock order: users in ID order, then plan, then company.
      const users = await trx('users').whereIn('id', [userId, recipient.id]).orderBy('id').forUpdate();
      const user = users.find((row) => row.id === userId && row.company_id === actor.companyId && !row.deleted_at);
      const platform = users.find((row) => row.id === recipient.id && row.role === 'superadmin' && !row.deleted_at);
      if (!user || user.role === 'superadmin')
        throw new HTTP404Error({ message: 'Add-on recipient must be a user in your company' });
      if (!platform) throw new HTTP400Error({ message: 'Platform wallet recipient is unavailable' });
      const plan = await trx('user_plans')
        .where({ id: planId, user_id: userId, company_id: actor.companyId })
        .forUpdate()
        .first();
      const company = await trx('companies').where({ id: actor.companyId }).forUpdate().first();
      if (!company) throw new HTTP404Error({ message: 'Company not found' });
      const existing = await trx('user_plan_addons')
        .where({ company_id: actor.companyId, idempotency_key: idempotencyKey })
        .first();
      if (existing) {
        if (existing.request_hash !== hash)
          throw new HTTP400Error({ message: 'Idempotency-Key was used for a different add-on purchase' });
        return existing;
      }
      const now = new Date();
      if (!plan || !plan.active || !(new Date(plan.start_date) <= now && now < new Date(plan.end_date))) {
        throw new HTTP400Error({ message: 'The selected user plan is inactive, expired, or has been replaced' });
      }
      if (plan.billing_cycle === 'Free') throw new HTTP400Error({ message: 'Add-ons require a paid plan' });
      const selections = snapshotPlanAddons(plan.addons);
      if (selections !== null && !selections.some(selection => selection.addon_id === addonId.toLowerCase() && selection.enabled))
        throw new HTTP403Error({ message: 'This add-on is not enabled for the assigned subscription plan',
          details: { code: 'PLAN_ADDON_DISABLED', addon_id: addonId } });
      const addon = await trx('plan_addons').where({ id: addonId, active: true }).forShare().first();
      if (!addon) throw new HTTP400Error({ message: 'Add-on is unavailable' });
      if (addon.company_id != null && addon.company_id !== actor.companyId) throw new HTTP404Error({ message: 'Add-on is unavailable in your company' });
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
      const units = Number(addon.units) * quantity;
      const amount = Number(addon.price_paise) * quantity;
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
        !Number.isSafeInteger(amount)
      ) {
        throw new HTTP400Error({ message: 'Add-on exceeds supported limits' });
      }
      const before = walletPaise(company.credit_balance);
      const platformBefore = walletPaise(platform.credit_balance ?? 0);
      if (before < amount)
        throw new HTTP400Error({
          message: `Insufficient company wallet balance; required INR ${(amount / 100).toFixed(2)}`,
        });
      if (!Number.isSafeInteger(platformBefore + amount))
        throw new HTTP400Error({ message: 'Platform wallet exceeds supported balance' });
      const [purchase] = await trx('user_plan_addons')
        .insert({
          company_id: actor.companyId,
          user_id: userId,
          user_plan_id: plan.id,
          addon_id: addon.id,
          purchased_by: actor.userId,
          idempotency_key: idempotencyKey,
          request_hash: hash,
          feature_key: addon.feature_key,
          quantity,
          units,
          amount_paise: amount,
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
          user_id: userId,
          type: 'debit',
          amount: -amount / 100,
          balance_before: before / 100,
          balance_after: (before - amount) / 100,
          created_by: actor.userId,
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
          created_by: actor.userId,
          reference_type: 'plan_addon',
          reference_id: purchase.id,
          description: `Add-on from ${company.id}; purchase ${purchase.id}`,
        },
      ]);
      await trx('activity_logs').insert({
        company_id: company.id,
        user_id: actor.userId,
        action: 'CREATE',
        entity_type: 'SUBSCRIPTION',
        entity_id: plan.id,
        read: false,
        status: 'SUCCESS',
        description: `Purchased ${quantity} x ${addon.name} for user ${userId}`,
        new_data: JSON.stringify({
          purchase_id: purchase.id,
          feature_key: addon.feature_key,
          units,
          amount_paise: amount,
        }),
      });
      return purchase;
    });
  }
}
export default new PlanAddonService();
