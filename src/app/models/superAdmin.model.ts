import { BaseModel } from '@surefy/models/base.model';
import { Knex } from 'knex';
import { CompanyFields, SuperAdminFilters, CompanyCollection, CreditInput } from '../interfaces/superAdmin.interface';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import subscriptionModel from './subscription.model';

const companyColumns = [
  'id',
  'name',
  'email',
  'phone',
  'business_id',
  'status',
  'credit_balance',
  'created_at',
  'updated_at',
  'deleted_at',
];
const userColumns = [
  'id',
  'company_id',
  'name',
  'email',
  'phone',
  'role',
  'status',
  'last_login_at',
  'assigned_plan',
  'created_at',
  'updated_at',
];
const domainColumns = [
  'id',
  'company_id',
  'domain_name',
  'hostname',
  'domain_type',
  'status',
  'ssl_status',
  'created_at',
];

class SuperAdminModel extends BaseModel {
  constructor() {
    super('companies');
  }

  async activeAdministrator(id: string) {
    return this.db('users').where({ id, role: 'superadmin', status: 'active' }).whereNull('deleted_at').first('id');
  }

  private applyFilters(
    query: Knex.QueryBuilder,
    f: SuperAdminFilters,
    searchColumns: string[],
    companyColumn?: string,
  ) {
    if (f.search)
      query.where((builder) => {
        const pattern = `%${f.search!.replace(/[\\%_]/g, '\\$&')}%`;
        searchColumns.forEach((column) => builder.orWhereILike(column, pattern));
      });
    if (f.status) query.where('status', f.status);
    if (f.company_id && companyColumn) query.where(companyColumn, f.company_id);
    if (f.from) query.where('created_at', '>=', f.from);
    if (f.to) query.where('created_at', '<', f.to);
    return query;
  }

  private async page(query: Knex.QueryBuilder, columns: string[], f: SuperAdminFilters) {
    const [count, items] = await Promise.all([
      query.clone().count('* as total').first(),
      query
        .clone()
        .select(columns)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(f.limit)
        .offset((f.page - 1) * f.limit),
    ]);
    return { items, pagination: { page: f.page, limit: f.limit, total: Number(count?.total || 0) } };
  }

  companies(f: SuperAdminFilters) {
    const query = this.applyFilters(this.query().whereNull('deleted_at'), f, ['name', 'email', 'phone'], 'id');
    if (f.domain_status)
      query.whereExists(
        this.db('company_domains')
          .select(this.db.raw('1'))
          .whereRaw('company_domains.company_id = companies.id')
          .where('status', f.domain_status),
      );
    return this.page(query, companyColumns, f);
  }

  async company(id: string, trx: Knex | Knex.Transaction = this.db, lock = false) {
    const query = trx('companies').where({ id }).whereNull('deleted_at');
    if (lock) query.forUpdate();
    const row = await query.first(companyColumns);
    if (!row) throw new HTTP404Error({ message: 'Company not found' });
    return row;
  }

  async overview() {
    const [companies, users, domains] = await Promise.all([
      this.query()
        .whereNull('deleted_at')
        .select('status')
        .count('* as count')
        .sum('credit_balance as credit_balance')
        .groupBy('status'),
      this.db('users').whereNull('deleted_at').select('status').count('* as count').groupBy('status'),
      this.db('company_domains').select('status').count('* as count').groupBy('status'),
    ]);
    return { companies, users, domains };
  }

  async details(id: string) {
    const company = await this.company(id);
    const [users, domains, campaigns, contacts] = await Promise.all([
      this.db('users').where({ company_id: id }).whereNull('deleted_at').count('* as total').first(),
      this.db('company_domains').where({ company_id: id }).select(domainColumns),
      this.db('campaigns')
        .where({ company_id: id })
        .whereNull('deleted_at')
        .select('status')
        .count('* as count')
        .groupBy('status'),
      this.db('contacts').where({ company_id: id }).whereNull('deleted_at').count('* as total').first(),
    ]);
    return {
      company,
      domains,
      counts: { users: Number(users?.total || 0), contacts: Number(contacts?.total || 0) },
      campaigns,
    };
  }

  async collection(resource: CompanyCollection, f: SuperAdminFilters) {
    const definitions = {
      users: { table: 'users', columns: userColumns, search: ['name', 'email', 'phone'], soft: true },
      domains: { table: 'company_domains', columns: domainColumns, search: ['domain_name', 'hostname'], soft: false },
      activities: {
        table: 'activity_logs',
        columns: [
          'id',
          'company_id',
          'user_id',
          'action',
          'entity_type',
          'entity_id',
          'description',
          'status',
          'created_at',
        ],
        search: ['description', 'action'],
        soft: true,
      },
      credits: {
        table: 'credit_transactions',
        columns: [
          'id',
          'company_id',
          'type',
          'amount',
          'balance_before',
          'balance_after',
          'reference_type',
          'reference_id',
          'description',
          'created_by',
          'created_at',
        ],
        search: ['description'],
        soft: false,
      },
      audit: {
        table: 'superadmin_audit_logs',
        columns: ['id', 'actor_id', 'company_id', 'target_id', 'action', 'reason', 'changes', 'created_at'],
        search: ['action', 'reason'],
        soft: false,
      },
    };
    const d = definitions[resource];
    const query = this.db(d.table);
    if (d.soft) query.whereNull('deleted_at');
    if (f.user_id && resource === 'users') query.where('id', f.user_id);
    if (f.user_id && resource === 'activities') query.where('user_id', f.user_id);
    if (f.user_id && resource === 'audit') query.where('actor_id', f.user_id);
    const result = await this.page(this.applyFilters(query, f, d.search, 'company_id'), d.columns, f);
    if (resource !== 'users') return result;

    // Fetch assignment snapshots for this page in one query, rather than one query per user.
    // Keep expired/cancelled assignments visible so the dashboard can show their actual status.
    const assignedUsers = result.items.filter((user: { id: string; company_id: string; assigned_plan: string | null }) => user.assigned_plan);
    const plans = assignedUsers.length ? await this.db('user_plans')
      .where(builder => {
        for (const user of assignedUsers) builder.orWhere({
          id: user.assigned_plan, user_id: user.id, company_id: user.company_id,
        });
      })
      .select('id', 'user_id', 'company_id', 'subscription_id', 'plan_name', 'price',
        'billing_cycle', 'status', 'active', 'start_date', 'end_date', 'duration_days', 'limits', 'usage') : [];
    const byAssignment = new Map(plans.map(plan => [
      `${plan.company_id}:${plan.user_id}:${plan.id}`, plan,
    ]));
    return { ...result, items: result.items.map((user: { id: string; company_id: string; assigned_plan: string | null }) => ({
      ...user,
      plan_details: byAssignment.get(`${user.company_id}:${user.id}:${user.assigned_plan}`) ?? null,
    })) };
  }

  private audit(
    trx: Knex.Transaction,
    actor: string,
    company: string,
    target: string,
    action: string,
    reason: string,
    changes: unknown,
  ) {
    return trx('superadmin_audit_logs').insert({
      actor_id: actor,
      company_id: company,
      target_id: target,
      action,
      reason,
      changes: JSON.stringify(changes),
    });
  }

  async createCompany(actor: string, fields: CompanyFields, admin: Record<string, string>, reason: string) {
    return this.db.transaction(async (trx) => {
      const [company] = await trx('companies')
        .insert({ ...fields, status: 'active', credit_balance: '0.00' })
        .returning(companyColumns);
      const [user] = await trx('users')
        .insert({ ...admin, company_id: company.id, role: 'admin', status: 'active' })
        .returning(userColumns);
      await subscriptionModel.createFreePlan(user.id, company.id, trx);
      await this.audit(trx, actor, company.id, company.id, 'company.create', reason, {
        name: company.name,
        initial_admin_id: user.id,
      });
      return { company, user };
    });
  }

  async updateCompany(actor: string, id: string, changes: Record<string, unknown>, reason: string, remove = false) {
    return this.db.transaction(async (trx) => {
      const before = await this.company(id, trx, true);
      if (remove || (changes.status && changes.status !== 'active')) {
        const protectedUser = await trx('users')
          .where({ company_id: id, role: 'superadmin' })
          .whereNull('deleted_at')
          .first('id');
        if (protectedUser) throw new HTTP400Error({ message: 'Cannot disable a company containing a superadmin' });
      }
      const [company] = await trx('companies')
        .where({ id })
        .update({
          ...changes,
          ...(remove ? { deleted_at: trx.fn.now(), status: 'inactive' } : {}),
          updated_at: trx.fn.now(),
        })
        .returning(companyColumns);
      if (!remove && changes.status) {
        await trx('users').where({ company_id: id }).whereNull('deleted_at')
          .update({ status: changes.status, updated_at: trx.fn.now() });
      }
      await this.audit(trx, actor, id, id, remove ? 'company.delete' : 'company.update', reason, {
        before: Object.fromEntries(Object.keys(changes).map((key) => [key, before[key]])),
        after: remove ? { deleted: true } : changes,
      });
      return company;
    });
  }

  async updateUser(actor: string, companyId: string, userId: string, changes: Record<string, unknown>, reason: string) {
    return this.db.transaction(async (trx) => {
      await this.company(companyId, trx, true);
      const user = await trx('users')
        .where({ id: userId, company_id: companyId })
        .whereNull('deleted_at')
        .forUpdate()
        .first(userColumns);
      if (!user) throw new HTTP404Error({ message: 'User not found in this company' });
      if (user.role === 'superadmin' || userId === actor)
        throw new HTTP400Error({ message: 'Superadmin accounts cannot be modified through company management' });
      const [updated] = await trx('users')
        .where({ id: userId })
        .update({ ...changes, updated_at: trx.fn.now() })
        .returning(userColumns);
      await this.audit(trx, actor, companyId, userId, 'user.update', reason, {
        before: Object.fromEntries(Object.keys(changes).map((key) => [key, user[key]])),
        after: changes,
      });
      return updated;
    });
  }

  /** Lock balance and persist ledger/audit together; a retried request cannot credit twice. */
  async addCredit(actor: string, companyId: string, input: CreditInput) {
    return this.db.transaction(async (trx) => {
      const company = await this.company(companyId, trx, true);
      const previous = await trx('credit_transactions')
        .where({ company_id: companyId, reference_type: 'superadmin_manual', reference_id: input.request_id })
        .first();
      if (previous) {
        if (
          Number(previous.amount).toFixed(2) !== input.amount ||
          previous.description !== input.reason ||
          previous.created_by !== actor
        ) {
          throw new HTTP400Error({ message: 'request_id already used with different credit details' });
        }
        return { transaction_id: previous.id, balance_after: previous.balance_after, replayed: true };
      }
      const [updated] = await trx('companies')
        .where({ id: companyId })
        .update({ credit_balance: trx.raw('credit_balance + ?::numeric', [input.amount]), updated_at: trx.fn.now() })
        .returning('credit_balance');
      const [entry] = await trx('credit_transactions')
        .insert({
          company_id: companyId,
          type: 'credit',
          amount: input.amount,
          balance_before: company.credit_balance,
          balance_after: updated.credit_balance,
          reference_type: 'superadmin_manual',
          reference_id: input.request_id,
          description: input.reason,
          created_by: actor,
        })
        .returning('id');
      await this.audit(trx, actor, companyId, entry.id, 'company.credit', input.reason, {
        amount: input.amount,
        request_id: input.request_id,
      });
      return { transaction_id: entry.id, balance_after: updated.credit_balance, replayed: false };
    });
  }
}
export default new SuperAdminModel();
