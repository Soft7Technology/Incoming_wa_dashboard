import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import { normalizeFeatures } from '../utils/planFeatures';

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
  addons() {
    return db('plan_addons').where({ active: true }).orderBy('name');
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
      ['constructor', 'prototype', '__proto__', 'TeamMembers', 'WABANumber', 'AIAssistant'].includes(key)
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
    const feature_key = textField(body.feature_key, 'feature_key', 64);
    const feature = await db('plan_features').where({ key: feature_key, active: true, addon_allowed: true }).first();
    if (!feature) throw new HTTP400Error({ message: 'Feature is inactive, unknown, or does not allow add-ons' });
    const [addon] = await db('plan_addons')
      .insert({
        name: textField(body.name, 'name', 100),
        feature_key,
        units: positiveInt(body.units, 'units', 2147483647),
        price_paise: positiveInt(body.price_paise, 'price_paise'),
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
}
export default new PlanCatalogService();
