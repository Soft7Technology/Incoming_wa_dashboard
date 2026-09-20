import { BaseModel } from '@surefy/models/base.model';

class WabaModel extends BaseModel {
  constructor() {
    super('waba_accounts');
  }

  async findByCompanyId(companyId: string) {
    return this.query().where({ company_id: companyId, deleted_at: null });
  }


  async findByUserId(userId?: string, companyId?: string) {
    if (!userId || !companyId) throw new Error('User and company context are required');
    return this.query()
      .where({ 'waba_accounts.user_id': userId, 'waba_accounts.company_id': companyId })
      .whereNull('waba_accounts.deleted_at')
      .select('*');
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId }).first();
  }

  async findByIdInternal(id: string) {
    return this.findById(id);
  }

  async findWABA(id:string){
    console.log("Id",id)
    return this.query().where({id}).first()
  }
}

export default new WabaModel();
