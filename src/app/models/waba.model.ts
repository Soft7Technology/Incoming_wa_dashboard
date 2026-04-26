import { BaseModel } from '@surefy/models/base.model';

class WabaModel extends BaseModel {
  constructor() {
    super('waba_accounts');
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
