import { BaseModel } from '@surefy/models/base.model';

class CompanyDomainModel extends BaseModel {
  constructor() {
    super('company_domains');
  }

  async getCompanyDomains(userId: string) {
    return this.query().returning("*")
  }

  async getCompanyDomainById(custom_domain: string) {
    return this.query().where("id", custom_domain).first()
  }

  async findCompanyDomainByCompanyId(companyId: string) {
    return this.query()
      .where('company_id', companyId)
      .whereIn('domain_type', ['own', 'custom']);
  }

  async findDomainByCompanyId(company_id: string, domain_name: string) {
    return this.query()
      .where('domain_name', domain_name)
      .andWhere('company_id', company_id)
      .first();
  }

  async findByDomain(domain_name: string) {
    return this.query()
      .where('domain_name', domain_name)
      .first();
  }

  async domainById(domainId:string){
    return this.query()
      .where('id',domainId)
      .first()
  }


}


export default new CompanyDomainModel();