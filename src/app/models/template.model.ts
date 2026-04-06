import { BaseModel } from '@surefy/models/base.model';

class TemplateModel extends BaseModel {
  constructor() {
    super('templates');
  }

  async findByCompanyId(userId: string, filters: any = {}) {
    const query = this.query().where({ user_id: userId, deleted_at: null });

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

  async findByNameAndLanguage(userId: string, name: string, language: string) {
    return this.query()
      .where({ user_id: userId, name, language, deleted_at: null })
      .first();
  }

  async updateSyncTimestamp(id: string) {
    return this.update(id, { synced_at: new Date() });
  }
}

export default new TemplateModel();
