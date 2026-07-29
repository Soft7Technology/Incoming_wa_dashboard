import { BaseModel } from '@surefy/models/base.model';

class CompanyDomainModel extends BaseModel {
  constructor() {
    super('company_domains');
  }
 
  async getCompanyDomains(userId:string){
    return this.query().returning("*")
  }

  async getCompanyDomainById(custom_domain:string){
    return this.query().where("id",custom_domain).first()
  }

}

 
export default new CompanyDomainModel();