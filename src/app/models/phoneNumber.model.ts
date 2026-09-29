import { BaseModel } from '@surefy/models/base.model';
import { validate as uuidValidate } from 'uuid';

class PhoneNumberModel extends BaseModel {
  constructor() {
    super('phone_numbers');
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

  async findByPhoneNumberId(phoneNumberId: any) {
    console.log('Finding phone number with ID:', phoneNumberId); // Debug log
    if (!phoneNumberId) return null;
    const isUuid = typeof phoneNumberId === 'string' && uuidValidate(phoneNumberId);
    return this.query()
      .where((qb) => {
        qb.where('phone_number_id', phoneNumberId);
        if (isUuid) {
          qb.orWhere('id', phoneNumberId);
        }
      })
      .andWhere({ deleted_at: null })
      .first();
  }

  async findByPhoneId(phoneNumberId: string) {
    return this.query().where({ id: phoneNumberId }).first();
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId, deleted_at: null });
  }
}

export default new PhoneNumberModel();
