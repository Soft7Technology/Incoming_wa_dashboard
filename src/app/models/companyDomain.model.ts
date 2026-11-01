import { BaseModel } from '@surefy/models/base.model';
import { platformOrganization } from '../utils/platformOrganization';

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

  async findLoginDomain(user: { id: string; role?: string; company_id: string }, domain: string) {
    const current = await this.findDomainByCompanyId(user.company_id, domain);
    if (current) return current;
    const settings = await platformOrganization(this.db, user);
    if (!Array.isArray(settings?.legacy_login_domain_ids) || !Array.isArray(settings?.legacy_company_ids)) return undefined;
    return this.query().whereIn('id', settings.legacy_login_domain_ids)
      .whereIn('company_id', settings.legacy_company_ids).where({ domain_name: domain, status: 'active' }).first();
  }

  async findDefaultLoginDomain(user: { id: string; role?: string; company_id: string }) {
    const current = await this.findOne({ company_id: user.company_id, status: 'active' });
    if (current) return current;
    const settings = await platformOrganization(this.db, user);
    return settings?.preferred_login_domain ? this.findLoginDomain(user, settings.preferred_login_domain) : undefined;
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
