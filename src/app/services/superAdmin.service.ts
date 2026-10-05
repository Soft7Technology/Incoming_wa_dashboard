import bcrypt from 'bcrypt';
import model from '../models/superAdmin.model';
import { CompanyFields, CompanyCollection, UserCollection } from '../interfaces/superAdmin.interface';
import * as validate from '../utils/superAdminValidation';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class SuperAdminService {
  /** Check the database role, not only the role embedded in an older JWT. */
  async authorize(actor: string | undefined) {
    if (!actor || !await model.activeAdministrator(actor)) throw new HTTP403Error({ message: 'Active superadmin access required' });
  }

  overview() { return model.overview(); }
  companies(query: Record<string, unknown>) { return model.companies(validate.filters(query)); }
  company(id: string) { return model.details(validate.uuid(id, 'companyId')); }
  companyOverview(id: string) { return model.companyOverview(validate.uuid(id, 'companyId')); }
  userDetails(id: string, companyId?: string) {
    validate.uuid(id, 'userId');
    if (companyId !== undefined) validate.uuid(companyId, 'companyId');
    return model.userDetails(id, companyId);
  }
  userOverview(companyId: string, userId: string) {
    validate.uuid(companyId, 'companyId');
    validate.uuid(userId, 'userId');
    return model.userOverview(companyId, userId);
  }
  userActivePlan(companyId: string, userId: string) {
    validate.uuid(companyId, 'companyId');
    validate.uuid(userId, 'userId');
    return model.userActivePlan(companyId, userId);
  }
  async userCollection(resource: UserCollection, query: Record<string, unknown>, companyId: string, userId: string) {
    validate.uuid(companyId, 'companyId');
    validate.uuid(userId, 'userId');
    const filters = validate.filters(query);
    validate.requireInput(!filters.domain_status, 'domain_status is not a filter for this resource');
    // URL scope always wins over valid query scope, including for count queries.
    filters.company_id = companyId;
    filters.user_id = userId;
    await model.user(userId, companyId);
    return model.collection(resource, filters);
  }
  async collection(resource: CompanyCollection, query: Record<string, unknown>, companyId?: string) {
    const filters = validate.filters(query);
    if (resource === 'activities')
      validate.requireInput(!filters.domain_status, 'domain_status is not a filter for this resource');
    if (resource === 'messages' || resource === 'campaigns' || resource === 'contacts') {
      validate.requireInput(companyId, 'companyId is required for this resource');
      validate.requireInput(!filters.domain_status, 'domain_status is not a filter for this resource');
    }
    if (companyId) {
      filters.company_id = validate.uuid(companyId, 'companyId');
      await model.company(companyId);
    }
    validate.requireInput(!filters.status || !['credits', 'audit'].includes(resource), 'status is not a filter for this resource');
    return model.collection(resource, filters);
  }
  
  private fields(data: Record<string, unknown>, create = false) {
    const fields: Record<string, string> = {};
    for (const key of ['name', 'email', 'phone', 'business_id']) {
      if (data[key] !== undefined || create && ['name', 'email'].includes(key)) {
        fields[key] = key === 'email' ? validate.email(data[key]) : validate.text(data[key], key, key === 'phone' ? 50 : 255);
      }
    }
    return fields;
  }
  private async write<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error: any) {
      if (error.code === '23505') throw new HTTP400Error({ message: 'A record with this email, phone or identifier already exists' });
      if (error.code === '22003') throw new HTTP400Error({ message: 'Credit balance exceeds the supported maximum' });
      throw error;
    }
  }
  async createCompany(actor: string, body: unknown) {
    const data = validate.object(body);
    validate.allowed(data, ['name', 'email', 'phone', 'business_id', 'user', 'reason']);
    const fields = this.fields(data, true) as unknown as CompanyFields;
    const user = validate.object(data.user);
    validate.allowed(user, ['name', 'email', 'phone', 'password']);
    const admin = this.fields(user, true);
    validate.requireInput(typeof user.password === 'string' && user.password.length >= 12 && Buffer.byteLength(user.password, 'utf8') <= 72,
      'Initial admin password must contain at least 12 characters and at most 72 UTF-8 bytes');
    admin.password = await bcrypt.hash(user.password, 12);
    const reason = validate.text(data.reason, 'reason', 1000);
    return this.write(() => model.createCompany(actor, fields, admin, reason));
  }
  updateCompany(actor: string, id: string, body: unknown) {
    validate.uuid(id, 'companyId');
    const data = validate.object(body);
    validate.allowed(data, ['name', 'email', 'phone', 'business_id', 'reason']);
    const fields = this.fields(data);
    validate.requireInput(Object.keys(fields).length, 'Provide at least one company field');
    const reason = validate.text(data.reason, 'reason', 1000);
    return this.write(() => model.updateCompany(actor, id, fields, reason));
  }
  companyStatus(actor: string, id: string, body: unknown) {
    validate.uuid(id, 'companyId');
    const data = validate.object(body);
    validate.allowed(data, ['status', 'reason']);
    return model.updateCompany(actor, id, { status: validate.status(data.status) }, validate.text(data.reason, 'reason', 1000));
  }
  deleteCompany(actor: string, id: string, body: unknown) {
    validate.uuid(id, 'companyId');
    const data = validate.object(body);
    validate.allowed(data, ['reason']);
    return model.updateCompany(actor, id, {}, validate.text(data.reason, 'reason', 1000), true);
  }
  updateUser(actor: string, companyId: string, userId: string, body: unknown, statusOnly = false) {
    validate.uuid(companyId, 'companyId'); validate.uuid(userId, 'userId');
    const data = validate.object(body);
    validate.allowed(data, statusOnly ? ['status', 'reason'] : ['name', 'email', 'phone', 'reason']);
    const fields = statusOnly ? { status: validate.status(data.status) } : this.fields(data);
    validate.requireInput(Object.keys(fields).length, 'Provide at least one user field');
    const reason = validate.text(data.reason, 'reason', 1000);
    return this.write(() => model.updateUser(actor, companyId, userId, fields, reason));
  }
  addCredit(actor: string, companyId: string, body: unknown) {
    validate.uuid(companyId, 'companyId');
    const data = validate.object(body);
    validate.allowed(data, ['amount', 'reason', 'request_id']);
    const input = { amount: validate.creditAmount(data.amount), reason: validate.text(data.reason, 'reason', 1000), request_id: validate.uuid(data.request_id, 'request_id') };
    return this.write(() => model.addCredit(actor, companyId, input));
  }
}
export default new SuperAdminService();
