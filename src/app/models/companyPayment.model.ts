import { Knex } from 'knex';
import db from '@surefy/database';

type PaymentScope = { company_id: string; user_id: string };

class CompanyPaymentModel {
  lockCompany(trx: Knex.Transaction, companyId: string) {
    // All configuration changes and order reservations serialize on this row.
    return trx('companies').where({ id: companyId }).forUpdate().first('id');
  }

  deactivateGateways(trx: Knex.Transaction, companyId: string, mode: string) {
    return trx('company_payment_gateways')
      .where({ company_id: companyId, mode, active: true })
      .update({ active: false });
  }

  insertGateway(trx: Knex.Transaction, data: Record<string, unknown>) {
    return trx('company_payment_gateways').insert(data);
  }

  activeConfigurations(companyId: string) {
    // Deliberately exclude encrypted credentials from dashboard reads.
    return db('company_payment_gateways')
      .where({ company_id: companyId, active: true })
      .select('id', 'provider', 'mode', 'display_name', 'active', 'created_at');
  }

  findExistingOrder(trx: Knex.Transaction, scope: PaymentScope, idempotencyKey: string) {
    return trx('company_payment_orders')
      .where({ ...scope, idempotency_key: idempotencyKey })
      .first();
  }

  activeGateway(trx: Knex.Transaction, companyId: string, mode: string) {
    return trx('company_payment_gateways').where({ company_id: companyId, mode, active: true }).first();
  }

  async insertOrder(trx: Knex.Transaction, data: Record<string, unknown>) {
    const [order] = await trx('company_payment_orders').insert(data).returning('*');
    return order;
  }

  async updateOrder(scope: PaymentScope, id: string, data: Record<string, unknown>) {
    const [order] = await db('company_payment_orders')
      .where({ id, ...scope })
      .update(data)
      .returning('*');
    return order;
  }

  findOrder(companyId: string, id: string, userId?: string) {
    const query = db('company_payment_orders').where({ id, company_id: companyId });
    if (userId) query.andWhere({ user_id: userId });
    return query.first();
  }

  findGateway(companyId: string, id: string) {
    // Historical configurations remain available to verify their existing orders.
    return db('company_payment_gateways').where({ id, company_id: companyId }).first();
  }

  markPaid(companyId: string, id: string) {
    // Preserve the original paid timestamp on retries and concurrent confirmations.
    return db('company_payment_orders')
      .where({ id, company_id: companyId })
      .whereNot('status', 'paid')
      .update({ status: 'paid', paid_at: new Date(), updated_at: new Date() });
  }
}

export default new CompanyPaymentModel();
