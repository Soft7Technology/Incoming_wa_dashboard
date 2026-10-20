import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import { normalizeFeatures, featureKey, snapshotPlanAddons } from '../utils/planFeatures';

export interface CatalogActor {
  userId?: string;
  companyId?: string;
  userRole?: string;
}
export function platformAdmin(actor: CatalogActor) {
  if (!actor.userId || actor.userRole !== 'superadmin')
    throw new HTTP403Error({ message: 'Only superadmin can manage the platform feature and add-on catalog' });
}
export function textField(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HTTP400Error({ message: `${name} must be a non-empty string of at most ${max} characters` });
  return value.trim();
}
export function positiveInt(value: unknown, name: string, max = 100000000) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new HTTP400Error({ message: `${name} must be a positive integer up to ${max}` });
  return value;
}

class PlanCatalogService {
  features() {
    return db('plan_features').orderBy('label');
  }
  addons(includeInactive = false, companyId?: string, allCompanies = false) {
    const query = db('plan_addons').orderBy('name');
    if (!allCompanies) query.where(scope => {
      scope.whereNull('company_id');
      if (companyId) scope.orWhere({ company_id: companyId });
    });
    return includeInactive ? query : query.where({ active: true });
  }

  async validatePlanAddons(input: unknown, inputFeatures: unknown, billingCycle: string, companyId?: string) {
    if (input !== undefined && !Array.isArray(input)) throw new HTTP400Error({ message: 'addons must be an array; use [] to disable all add-ons' });
    const selections = snapshotPlanAddons(input ?? [])!;
    if (!selections.length) return selections;
    const features = normalizeFeatures(typeof inputFeatures === 'string' ? JSON.parse(inputFeatures) : inputFeatures);
    const rows = await db('plan_addons').whereIn('id', selections.map(row => row.addon_id)).where(scope => {
      scope.whereNull('company_id');
      if (companyId) scope.orWhere({ company_id: companyId });
    });
    const byId = new Map(rows.map(row => [row.id, row]));
    const definitions = await db('plan_features').whereIn('key', [...new Set(rows.map(row => row.feature_key))]);
    const registry = new Map(definitions.map(row => [row.key, row]));
    for (const selection of selections) {
      const addon = byId.get(selection.addon_id);
      if (!addon) throw new HTTP400Error({ message: 'Selected add-on does not exist or is unavailable to this company' });
      if (!selection.enabled) continue;
      const feature = features[addon.feature_key], definition = registry.get(addon.feature_key);
      if (billingCycle === 'Free' || !addon.active || !definition?.active || !definition.addon_allowed ||
          !feature || feature.enabled === false || feature.limit_value === null) throw new HTTP400Error({
        message: `Cannot enable ${addon.name}: add-ons need an active pack and an included, enabled feature with a finite limit on a paid plan`,
      });
    }
    return selections;
  }

  async planAddons(actor: CatalogActor, planId?: string, includeInactive = false) {
    let plan: any;
    if (planId !== undefined) {
      if (!actor.userId || !actor.companyId || !['admin', 'company', 'superadmin'].includes(actor.userRole || ''))
        throw new HTTP403Error({ message: 'Company administrator required' });
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(planId)) throw new HTTP400Error({ message: 'plan_id must be a UUID' });
      plan = await db('subscription_plans').where({ id: planId, company_id: actor.companyId }).first();
      if (!plan) throw new HTTP400Error({ message: 'Subscription plan not found in your company' });
    }
    const selections = plan ? snapshotPlanAddons(plan.addons) : [];
    const features = plan ? normalizeFeatures(typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features) : {};
    return (await this.addons(Boolean(plan) || includeInactive, actor.companyId)).map(addon => ({ ...addon,
      editable: Boolean(addon.company_id && addon.company_id === actor.companyId && ['admin', 'company'].includes(actor.userRole || '')),
      enabled: plan ? selections === null ? plan.billing_cycle !== 'Free' && features[addon.feature_key]?.enabled === true &&
        features[addon.feature_key]?.limit_value !== null : selections.some(row => row.addon_id === addon.id && row.enabled) : false,
    }));
  }

  async validateFeatures(input: unknown, billingCycle?: string) {
    const features = normalizeFeatures(input);
    const keys = Object.keys(features);
    const rows = keys.length ? await db('plan_features').whereIn('key', keys).where({ active: true }) : [];
    const registry = new Map(rows.map((row) => [row.key, row]));
    for (const key of keys) {
      const row = registry.get(key);
      if (!row) throw new HTTP400Error({ message: `Unknown or inactive feature: ${key}; register it first` });
      if (row.kind === 'usage') {
        features[key].reset_period =
          billingCycle === 'Yearly' ? 'yearly' : billingCycle === 'Monthly' ? 'monthly' : 'never';
      }
      if (row.kind === 'capacity' && features[key].reset_period !== 'never') {
        throw new HTTP400Error({ message: `${key} is a capacity limit and cannot reset monthly or yearly` });
      }
    }
    return features;
  }

  async createFeature(actor: CatalogActor, body: any) {
    platformAdmin(actor);
    const key = textField(body.key, 'key', 64);
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) ||
      ['constructor', 'prototype', '__proto__'].includes(key) || featureKey(key) !== key
    )
      throw new HTTP400Error({ message: 'Invalid or reserved feature key' });
    if (!['capacity', 'usage'].includes(body.kind))
      throw new HTTP400Error({ message: 'kind must be capacity or usage' });
    if (body.addon_allowed !== undefined && typeof body.addon_allowed !== 'boolean')
      throw new HTTP400Error({ message: 'addon_allowed must be boolean' });
    const [row] = await db('plan_features')
      .insert({
        key,
        label: textField(body.label, 'label', 100),
        description: body.description === undefined ? '' : textField(body.description, 'description', 500),
        kind: body.kind,
        addon_allowed: body.addon_allowed ?? true,
      })
      .onConflict('key')
      .ignore()
      .returning('*');
    if (!row) throw new HTTP400Error({ message: 'Feature key already exists' });
    return row;
  }

  async createAddon(actor: CatalogActor, body: any) {
    platformAdmin(actor);
    if (body.active !== undefined && typeof body.active !== 'boolean') throw new HTTP400Error({ message: 'active must be boolean' });
    const feature_key = featureKey(textField(body.feature_key, 'feature_key', 64));
    const feature = await db('plan_features').where({ key: feature_key, active: true, addon_allowed: true }).first();
    if (!feature) throw new HTTP400Error({ message: 'Feature is inactive, unknown, or does not allow add-ons' });
    const [addon] = await db('plan_addons')
      .insert({
        name: textField(body.name, 'name', 100),
        feature_key,
        units: positiveInt(body.units, 'units', 2147483647),
        price_paise: positiveInt(body.price_paise, 'price_paise'),
        active: body.active ?? true,
      })
      .returning('*');
    return addon;
  }

  async disableAddon(actor: CatalogActor, id: string) {
    platformAdmin(actor);
    const [row] = await db('plan_addons')
      .where({ id })
      .update({ active: false, updated_at: new Date() })
      .returning('*');
    if (!row) throw new HTTP400Error({ message: 'Add-on not found' });
    return row;
  }

  async updateAddon(actor: CatalogActor, id: string, body: any) {
    platformAdmin(actor);
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
      throw new HTTP400Error({ message: 'Add-on ID must be a UUID' });
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
        Object.keys(body).some(key => !['name', 'units', 'price_paise', 'active'].includes(key))) {
      throw new HTTP400Error({ message: 'Only name, units, price_paise and active can be updated; feature_key is immutable' });
    }
    const values: any = {};
    if (body.name !== undefined) values.name = textField(body.name, 'name', 100);
    if (body.units !== undefined) values.units = positiveInt(body.units, 'units', 2147483647);
    if (body.price_paise !== undefined) values.price_paise = positiveInt(body.price_paise, 'price_paise');
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new HTTP400Error({ message: 'active must be boolean' });
      values.active = body.active;
    }
    return db.transaction(async trx => {
      const previous = await trx('plan_addons').where({ id }).forUpdate().first();
      if (!previous) throw new HTTP400Error({ message: 'Add-on not found' });
      const [row] = await trx('plan_addons').where({ id })
        .update({ ...values, updated_at: new Date() }).returning('*');
      await trx('platform_pricing_changes').insert({ actor_id: actor.userId, resource_type: 'addon', resource_id: id,
        previous_values: JSON.stringify(Object.fromEntries(Object.keys(values).map(key => [key, previous[key]]))),
        new_values: JSON.stringify(values) });
      return row;
    });
  }
}
export default new PlanCatalogService();
