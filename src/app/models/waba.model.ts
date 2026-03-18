import { BaseModel } from '@surefy/models/base.model';

class WabaModel extends BaseModel {
  constructor() {
    super('waba_accounts');
  }

  async findByCompanyId(companyId: string) {
    return this.query().where({ company_id: companyId, deleted_at: null });
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId }).first();
  }

  async findByIdInternal(id: string) {
    return this.findById(id);
  }
}

export default new WabaModel();
