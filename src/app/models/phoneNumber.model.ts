import { BaseModel } from '@surefy/models/base.model';
import { validate as uuidValidate } from 'uuid';
import { Knex } from 'knex';
import planUsage from '../services/planUsage.service';

class PhoneNumberModel extends BaseModel {
  constructor() {
    super('phone_numbers');
  }

  async create(data: any, trx?: Knex.Transaction) {
    if (trx) return super.create(data, trx);
    return planUsage.run(data.user_id, 'WabaNumber', transaction => {
      const active = data.active !== false && data.status !== 'inactive';
      return super.create({ ...data, active, inactive_reason: active ? null :
        'MANUALLY_DISABLED' }, transaction);
    });
  }

  async findByCompanyId(companyId: string) {
    return this.query().where({ company_id: companyId, deleted_at: null });
  }

  async findByUserId(userId?: string, companyId?: string) {
    if (!userId || !companyId) throw new Error('User and company context are required');
    return this.query()
      .where({ 'phone_numbers.user_id': userId, 'phone_numbers.company_id': companyId })
      .whereNull('phone_numbers.deleted_at')
      .leftJoin('waba_accounts as wa', 'phone_numbers.waba_id', 'wa.id')
      .select('phone_numbers.*', 'wa.waba_id');
  }

  async findByPhoneNumberId(phoneNumberId: any, trx?: Knex.Transaction) {
    if (!phoneNumberId) return null;
    const isUuid = typeof phoneNumberId === 'string' && uuidValidate(phoneNumberId);
    return (trx ? trx(this.tableName) : this.query())
      .where((qb) => {
        qb.where('phone_number_id', phoneNumberId);
        if (isUuid) {
          qb.orWhere('id', phoneNumberId);
        }
      })
      .andWhere({ deleted_at: null })
      .first();
  }

  async findOwnedByIdentifiers(userId: string, companyId: string, identifiers: string[]) {
    if (!identifiers.length) return [];
    const ids = [...new Set(identifiers)];
    const uuidIds = ids.filter(uuidValidate);
    return this.query().select('id', 'phone_number_id', 'active', 'connection_status')
      .where({ user_id: userId, company_id: companyId }).whereNull('deleted_at')
      .andWhere(query => {
        query.whereIn('phone_number_id', ids);
        if (uuidIds.length) query.orWhereIn('id', uuidIds);
      });
  }

  async findByPhoneId(phoneNumberId: string) {
    return this.query().where({ id: phoneNumberId }).first();
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId, deleted_at: null });
  }
}

export default new PhoneNumberModel();
