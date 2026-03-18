import { BaseModel } from '@surefy/models/base.model';

class TemplateModel extends BaseModel {
  constructor() {
    super('templates');
  }

  async findByCompanyId(companyId: string, filters: any = {}) {
    const query = this.query().where({ company_id: companyId, deleted_at: null });

    if (filters.status) {
      query.where({ status: filters.status });
    }

    if (filters.category) {
      query.where({ category: filters.category });
    }

    return query;
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId, deleted_at: null });
  }

  async findByNameAndLanguage(companyId: string, name: string, language: string) {
    return this.query()
      .where({ company_id: companyId, name, language, deleted_at: null })
      .first();
  }

  async updateSyncTimestamp(id: string) {
    return this.update(id, { synced_at: new Date() });
  }
}

export default new TemplateModel();
