import model from '../models/superAdminUserPlan.model';
import assignment from './planAssignment.service';
import * as v from '../utils/superAdminValidation';

class SuperAdminUserPlanService {
  private scope(companyId: string, userId: string, planId?: string) {
    v.uuid(companyId, 'companyId'); v.uuid(userId, 'userId');
    if (planId !== undefined) v.uuid(planId, 'userPlanId');
  }
  details(companyId: string, userId: string, planId: string) {
    this.scope(companyId, userId, planId);
    return model.details(companyId, userId, planId);
  }
  available(companyId: string, userId: string, query: Record<string, unknown>) {
    this.scope(companyId, userId);
    v.allowed(query, ['page', 'limit']);
    const { page, limit } = v.filters(query);
    return model.available(companyId, userId, page, limit);
  }
  availableForCompany(query: Record<string, unknown>) {
    v.allowed(query, ['company_id', 'page', 'limit']);
    const companyId = v.uuid(query.company_id, 'company_id');
    const { page, limit } = v.filters(query);
    return model.availableForCompany(companyId, page, limit);
  }
  assign(actor: string, companyId: string, userId: string, body: unknown) {
    this.scope(companyId, userId);
    const data = v.object(body); v.allowed(data, ['subscription_id', 'reason']);
    const planId = v.uuid(data.subscription_id, 'subscription_id');
    const reason = v.text(data.reason, 'reason', 1000);
    return assignment.updateUser(userId, { assigned_plan: planId },
      { userId: actor, companyId, userRole: 'superadmin' }, false, { companyId, reason });
  }
  changeStatus(actor: string, companyId: string, userId: string, planId: string, body: unknown) {
    this.scope(companyId, userId, planId);
    const data = v.object(body); v.allowed(data, ['status', 'reason']);
    v.requireInput(data.status === 'active' || data.status === 'suspended', 'status must be active or suspended');
    return model.changeStatus(actor, companyId, userId, planId, data.status === 'active', v.text(data.reason, 'reason', 1000));
  }
}
export default new SuperAdminUserPlanService();
