import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CatalogActor, positiveInt, textField } from './planCatalog.service';
import { featureKey } from '../utils/planFeatures';

const allowedFeatures = ['WabaNumber', 'Chatbot', 'TeamInvite'];
function companyAdmin(actor: CatalogActor) {
  if (!actor.userId || !actor.companyId || !['admin', 'company'].includes(actor.userRole || ''))
    throw new HTTP403Error({ message: 'A company administrator is required to manage company add-ons' });
}
function fields(body: any, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
      Object.keys(body).some(key => !allowed.includes(key))) throw new HTTP400Error({
    message: `Only ${allowed.join(', ')} are accepted; prices are managed by superadmin`,
  });
  if (body.active !== undefined && typeof body.active !== 'boolean') throw new HTTP400Error({ message: 'active must be boolean' });
}
function uuid(id: string) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new HTTP400Error({ message: 'Add-on ID must be a UUID' });
}

class CompanyAddonService {
  async create(actor: CatalogActor, body: any) {
    companyAdmin(actor);
    fields(body, ['name', 'feature_key', 'units', 'active']);
    const feature_key = featureKey(textField(body.feature_key, 'feature_key', 64));
    if (!allowedFeatures.includes(feature_key)) throw new HTTP400Error({ message: 'Company add-ons support WabaNumber, Chatbot and TeamInvite' });
    const values = { name: textField(body.name, 'name', 100), feature_key,
      units: positiveInt(body.units, 'units', 2147483647), active: body.active ?? true };
    return db.transaction(async trx => {
      const feature = await trx('plan_features').where({ key: feature_key, active: true, addon_allowed: true }).first();
      if (!feature) throw new HTTP400Error({ message: 'Feature is inactive or does not allow add-ons' });
      const [addon] = await trx('plan_addons').insert({ ...values, company_id: actor.companyId,
        created_by: actor.userId, price_paise: 2000 }).returning('*');
      await trx('activity_logs').insert({ company_id: actor.companyId, user_id: actor.userId, action: 'CREATE',
        entity_type: 'SUBSCRIPTION', entity_id: addon.id, read: false, status: 'SUCCESS',
        description: `Created company add-on ${addon.name}`, new_data: JSON.stringify(values) });
      return { ...addon, editable: true };
    });
  }

  async update(actor: CatalogActor, id: string, body: any) {
    companyAdmin(actor); uuid(id); fields(body, ['name', 'units', 'active']);
    const changes: Record<string, any> = {};
    if (body.name !== undefined) changes.name = textField(body.name, 'name', 100);
    if (body.units !== undefined) changes.units = positiveInt(body.units, 'units', 2147483647);
    if (body.active !== undefined) changes.active = body.active;
    return db.transaction(async trx => {
      const previous = await trx('plan_addons').where({ id, company_id: actor.companyId }).forUpdate().first();
      if (!previous) throw new HTTP404Error({ message: 'Company add-on not found; shared and other-company packs cannot be edited here' });
      const [addon] = await trx('plan_addons').where({ id, company_id: actor.companyId })
        .update({ ...changes, updated_at: new Date() }).returning('*');
      await trx('activity_logs').insert({ company_id: actor.companyId, user_id: actor.userId, action: 'UPDATE',
        entity_type: 'SUBSCRIPTION', entity_id: addon.id, read: false, status: 'SUCCESS',
        description: `Updated company add-on ${addon.name}`, new_data: JSON.stringify(changes) });
      return { ...addon, editable: true };
    });
  }
}
export default new CompanyAddonService();
