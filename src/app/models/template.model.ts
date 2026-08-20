import { BaseModel } from '@surefy/models/base.model';

class TemplateModel extends BaseModel {
  constructor() {
    super('templates');
  }

  async findByCompanyId(userId: string, companyId?: string, wabaId?: string, filters: any = {}) {
    const query = this.query().whereNull('deleted_at');

    if (companyId) {
      query.where({ company_id: companyId });
    }

    if (wabaId) {
      query.where({ waba_id: wabaId });
    }

    if (filters.status) {
      query.where({ status: filters.status });
    }

    if (filters.category) {
      query.where({ category: filters.category });
    }

    return query.orderBy('created_at', 'desc');
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
