import { BaseModel } from '@surefy/models/base.model';
import { Knex } from 'knex';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';

const planColumns = ['id', 'user_id', 'company_id', 'subscription_id', 'plan_name', 'price',
  'billing_cycle', 'status', 'active', 'start_date', 'end_date', 'duration_days', 'limits', 'usage', 'created_at'];

class SuperAdminUserPlanModel extends BaseModel {
  constructor() { super('user_plans'); }

  private async user(companyId: string, userId: string, connection: Knex | Knex.Transaction = this.db, lock = false) {
    const query = connection('users').where({ id: userId, company_id: companyId }).whereNull('deleted_at');
    if (lock) query.forUpdate();
    const user = await query.first('id', 'company_id', 'name', 'email', 'status', 'role', 'assigned_plan');
    if (!user) throw new HTTP404Error({ message: 'User not found in this company' });
    return user;
  }

  async details(companyId: string, userId: string, planId: string) {
    const user = await this.user(companyId, userId);
    const plan = await this.query().where({ id: planId, company_id: companyId, user_id: userId }).first(planColumns);
    if (!plan) throw new HTTP404Error({ message: 'User plan not found for this user and company' });
    return { user, plan };
  }

  async available(companyId: string, userId: string, page: number, limit: number) {
    await this.user(companyId, userId);
    const query = this.db('subscription_plans').where({ company_id: companyId, active: true });
    const count = await query.clone().count('* as total').first();
    const items = await query.clone().select('id', 'company_id', 'plan_name', 'price', 'billing_cycle', 'active', 'features')
      .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).offset((page - 1) * limit);
    return { items, pagination: { page, limit, total: Number(count?.total || 0) } };
  }

  async changeStatus(actor: string, companyId: string, userId: string, planId: string, active: boolean, reason: string) {
    return this.db.transaction(async trx => {
      const user = await this.user(companyId, userId, trx, true);
      if (user.role === 'superadmin') throw new HTTP400Error({ message: 'Superadmin plans cannot be managed here' });
      const plan = await trx('user_plans').where({ id: planId, company_id: companyId, user_id: userId }).forUpdate().first();
      if (!plan) throw new HTTP404Error({ message: 'User plan not found for this user and company' });
      if (active) {
        const now = Date.now();
        const start = new Date(plan.start_date).getTime(), end = new Date(plan.end_date).getTime();
        if (plan.status !== 'COMPLETED' || !Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now)
          throw new HTTP400Error({ message: 'Only a completed, unexpired plan that has started can be activated' });
        const other = await trx('user_plans').where({ user_id: userId, active: true }).whereNot({ id: planId }).first('id');
        if (other) throw new HTTP400Error({ message: 'Suspend the current active plan before activating another' });
      }
      const [updated] = await trx('user_plans').where({ id: planId }).update({ active }).returning(planColumns);
      if (active) await trx('users').where({ id: userId }).update({ assigned_plan: planId, updated_at: trx.fn.now() });
      // Suspension preserves the paid period, snapshot and usage so it can be resumed.
      await trx('superadmin_audit_logs').insert({
        actor_id: actor, company_id: companyId, target_id: planId,
        action: active ? 'user_plan.activate' : 'user_plan.suspend', reason,
        changes: JSON.stringify({ user_id: userId, before: { active: plan.active }, after: { active } }),
      });
      return updated;
    });
  }
}
export default new SuperAdminUserPlanModel();
