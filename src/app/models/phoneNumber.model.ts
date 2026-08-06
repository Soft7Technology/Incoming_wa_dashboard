import { BaseModel } from '@surefy/models/base.model';

class PhoneNumberModel extends BaseModel {
  constructor() {
    super('phone_numbers');
  }

  async findByCompanyId(companyId: string) {
    return this.query().where({ company_id: companyId, deleted_at: null });
  }

async findByUserId(userId?: string, companyId?: string) {
  return this.query()
    .whereNull('deleted_at')
    .andWhere((qb) => {
      if (userId && companyId) {
        qb.where('user_id', userId).orWhere('company_id', companyId);
      } else if (userId) {
        qb.where('user_id', userId);
      } else if (companyId) {
        qb.where('company_id', companyId);
      }
    });
}


  async findByPhoneNumberId(phoneNumberId: any) {
    console.log('Finding phone number with ID:', phoneNumberId); // Debug log
    return this.query().where({ phone_number_id: phoneNumberId }).first();
  }

  async findByPhoneId(phoneNumberId: string) {
    return this.query().where({ id: phoneNumberId }).first();
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId, deleted_at: null });
  }
}

export default new PhoneNumberModel();
