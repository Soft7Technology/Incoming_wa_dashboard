import { BaseModel } from '@surefy/models/base.model';

class PhoneNumberModel extends BaseModel {
  constructor() {
    super('phone_numbers');
  }

  async findByCompanyId(companyId: string) {
    return this.query().where({ company_id: companyId, deleted_at: null });
  }

  async findByUserId(userId: string) {
    return this.query().where({ user_id: userId, deleted_at: null });
  }

  async findByPhoneNumberId(phoneNumberId: string) {
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
