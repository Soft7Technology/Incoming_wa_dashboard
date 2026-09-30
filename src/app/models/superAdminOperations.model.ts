import { BaseModel } from '@surefy/models/base.model';
import { Knex } from 'knex';
import { ReportResource, OperationsFilters } from '../interfaces/superAdminOperations.interface';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class SuperAdminOperationsModel extends BaseModel {
  constructor() {
    super('company_payment_orders');
  }

  private scope(query: Knex.QueryBuilder, f: OperationsFilters, date = 'created_at') {
    if (f.company_id) query.where('company_id', f.company_id);
    if (f.user_id) query.where('user_id', f.user_id);
    if (f.from) query.where(date, '>=', f.from);
    if (f.to) query.where(date, '<', f.to);
    return query;
  }

  /** Receipts and platform fees are separate ledgers; never add the two together. */
  async revenue(f: OperationsFilters, byCompany = false) {
    const receipts = this.scope(
      this.query().where({ status: 'paid', is_test: false }).whereNotNull('user_plan_id'),
      f,
      'paid_at',
    );
    const fees = this.scope(
      this.db('credit_transactions').where({ reference_type: 'subscription_commission', type: 'debit' }),
      f,
    );
    if (!byCompany) {
      const [subscription_receipts, platform] = await Promise.all([
        receipts.select('currency').sum('amount_paise as amount_minor').count('* as paid_orders').groupBy('currency'),
        fees
          .select(this.db.raw('COALESCE(SUM(ABS(amount::numeric)), 0)::text AS amount'))
          .count('* as fee_entries')
          .first(),
      ]);
      return {
        subscription_receipts,
        platform_commission: { currency: 'INR', ...platform },
        basis: 'gross recorded receipts and wallet commissions; excludes test orders; not net of refunds',
      };
    }
    // Page companies first, then aggregate only that page to keep reports bounded.
    const companies = this.db('companies');
    if (f.company_id) companies.where('id', f.company_id);
    if (f.search) companies.whereILike('name', `%${f.search.replace(/[\\%_]/g, '\\$&')}%`);
    const [count, rows] = await Promise.all([
      companies.clone().count('* as total').first(),
      companies
        .select('id', 'name', 'status', 'deleted_at')
        .orderBy('id')
        .limit(f.limit)
        .offset((f.page - 1) * f.limit),
    ]);
    const ids = rows.map((row) => row.id);
    const [paid, commission] = await Promise.all([
      receipts
        .whereIn('company_id', ids)
        .select('company_id', 'currency')
        .sum('amount_paise as amount_minor')
        .count('* as paid_orders')
        .groupBy('company_id', 'currency'),
      fees
        .whereIn('company_id', ids)
        .select('company_id')
        .select(this.db.raw('COALESCE(SUM(ABS(amount::numeric)), 0)::text AS amount'))
        .count('* as fee_entries')
        .groupBy('company_id'),
    ]);
    return {
      items: rows.map((company) => ({
        company,
        subscription_receipts: paid.filter((row: any) => row.company_id === company.id),
        platform_commission: {
          currency: 'INR',
          amount: '0',
          ...commission.find((row: any) => row.company_id === company.id),
        },
      })),
      pagination: { page: f.page, limit: f.limit, total: Number(count?.total || 0) },
    };
  }

  async subscriptionOverview(f: OperationsFilters) {
    const [revenue, subscriptions] = await Promise.all([
      this.revenue(f),
      this.scope(this.db('user_plans'), f).select('status', 'active').count('* as count').groupBy('status', 'active'),
    ]);
    return { revenue, subscriptions };
  }

  async list(resource: ReportResource, f: OperationsFilters) {
    const definitions = {
      subscriptions: {
        table: 'user_plans',
        columns: [
          'id',
          'company_id',
          'user_id',
          'subscription_id',
          'plan_name',
          'price',
          'billing_cycle',
          'active',
          'status',
          'start_date',
          'end_date',
          'created_at',
        ],
        search: 'plan_name',
      },
      plans: {
        table: 'subscription_plans',
        columns: ['id', 'company_id', 'user_id', 'plan_name', 'price', 'billing_cycle', 'active', 'created_at'],
        search: 'plan_name',
      },
      payments: {
        table: 'company_payment_orders',
        columns: [
          'id',
          'company_id',
          'user_id',
          'user_plan_id',
          'amount_paise',
          'currency',
          'is_test',
          'status',
          'paid_at',
          'fulfilled_at',
          'created_at',
        ],
        search: null,
      },
      tickets: {
        table: 'support_tickets',
        columns: ['id', 'company_id', 'user_id', 'status', 'forward_by', 'forward_superadmin', 'created_at'],
        search: null,
      },
    };
    const d = definitions[resource];
    const query = this.scope(this.db(d.table), f);
    if (f.status) query.where('status', f.status);
    if (f.search && d.search) query.whereILike(d.search, `%${f.search.replace(/[\\%_]/g, '\\$&')}%`);
    if (resource === 'tickets') {
      if (f.forwarded === true) query.whereNotNull('forward_superadmin');
      if (f.forwarded === false) query.whereNull('forward_superadmin');
      if (f.assigned_to) query.where('forward_superadmin', f.assigned_to);
    }
    const [count, items] = await Promise.all([
      query.clone().count('* as total').first(),
      query
        .select(d.columns)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(f.limit)
        .offset((f.page - 1) * f.limit),
    ]);
    return { items, pagination: { page: f.page, limit: f.limit, total: Number(count?.total || 0) } };
  }

  async ticket(id: string, trx: Knex | Knex.Transaction = this.db, lock = false) {
    const query = trx('support_tickets').where({ id });
    if (lock) query.forUpdate();
    const ticket = await query.first(
      'id',
      'company_id',
      'user_id',
      'status',
      'forward_by',
      'forward_superadmin',
      'created_at',
    );
    if (!ticket) throw new HTTP404Error({ message: 'Ticket not found' });
    return ticket;
  }

  async conversation(id: string, f: OperationsFilters) {
    const ticket = await this.ticket(id);
    const query = this.db('ticket_conversation').where({ ticket_id: id });
    const [count, messages] = await Promise.all([
      query.clone().count('* as total').first(),
      query
        .select('id', 'ticket_id', 'company_id', 'user_id', 'user_name', 'message', 'created_at')
        .orderBy('created_at')
        .orderBy('id')
        .limit(f.limit)
        .offset((f.page - 1) * f.limit),
    ]);
    return { ticket, messages, pagination: { page: f.page, limit: f.limit, total: Number(count?.total || 0) } };
  }

  async changeTicket(actor: string, id: string, action: 'forward' | 'reply' | 'status', value: string, reason: string) {
    return this.db.transaction(async (trx) => {
      const ticket = await this.ticket(id, trx, true);
      let result;
      if (action === 'forward') {
        const assignee = await trx('users')
          .where({ id: value, role: 'superadmin', status: 'active' })
          .whereNull('deleted_at')
          .first('id');
        if (!assignee) throw new HTTP400Error({ message: 'Target must be an active superadmin' });
        [result] = await trx('support_tickets')
          .where({ id })
          .update({ forward_by: actor, forward_superadmin: value })
          .returning(['id', 'forward_by', 'forward_superadmin']);
        // Keep legacy forwarded-conversation reads compatible when reassigned.
        await trx('ticket_conversation')
          .where({ ticket_id: id })
          .update({ forward_by: actor, forward_superadmin: value });
      } else if (action === 'reply') {
        if (ticket.status === 'closed') throw new HTTP400Error({ message: 'Reopen the ticket before replying' });
        const sender = await trx('users').where({ id: actor }).first('name');
        [result] = await trx('ticket_conversation')
          .insert({
            ticket_id: id,
            company_id: ticket.company_id,
            user_id: actor,
            user_name: sender.name,
            message: value,
            forward_by: ticket.forward_by,
            forward_superadmin: ticket.forward_superadmin,
          })
          .returning(['id', 'ticket_id', 'user_id', 'message', 'created_at']);
      } else {
        [result] = await trx('support_tickets').where({ id }).update({ status: value }).returning(['id', 'status']);
      }
      await trx('superadmin_audit_logs').insert({
        actor_id: actor,
        company_id: ticket.company_id,
        target_id: id,
        action: `ticket.${action}`,
        reason,
        changes: JSON.stringify(
          action === 'reply'
            ? { message_id: result.id }
            : { before: action === 'status' ? ticket.status : ticket.forward_superadmin, after: value },
        ),
      });
      return result;
    });
  }
}
export default new SuperAdminOperationsModel();
