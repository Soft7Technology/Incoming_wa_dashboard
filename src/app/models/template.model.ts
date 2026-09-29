import { BaseModel } from '@surefy/models/base.model';

class TemplateModel extends BaseModel {
  constructor() {
    super('templates');
  }

  async update(id: string | number, data: any) {
    const updateData = { ...data };

    // Serialize JSONB arrays explicitly; otherwise pg encodes them as SQL arrays.
    for (const column of ['components', 'meta_data']) {
      const value = updateData[column];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        updateData[column] = JSON.stringify(value);
      }
    }

    return super.update(id, updateData);
  }

  async findByCompanyId(userId: string, companyId?: string, wabaId?: string, filters: any = {}) {
    const query = this.query().whereNull('deleted_at')
      .whereIn('waba_id', this.db('waba_accounts').select('id').where({ user_id: userId, company_id: companyId }).whereNull('deleted_at'));

    if (companyId) {
      query.where({ company_id: companyId });
    }

    if (wabaId) {
      query.where({ waba_id: wabaId });
    }

    if (filters.status) {
      query.where({ status: filters.status });
    }

    if (filters.language) query.where({ language: filters.language });

    if (filters.category) {
      query.where({ category: filters.category });
    }

    return query.orderBy('created_at', 'desc');
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId, deleted_at: null });
  }

  async findByNameAndLanguage(companyId: string, name: string, language: string, wabaId?: string) {
    const query = this.query().where({ company_id: companyId, name, language, deleted_at: null });
    if (wabaId) query.where({ waba_id: wabaId });
    if (wabaId) return query.first();
    // Legacy callers without a WABA must never select another account's variant arbitrarily.
    const rows = await query.limit(2);
    return rows.length === 1 ? rows[0] : undefined;
  }

  async updateSyncTimestamp(id: string) {
    return this.update(id, { synced_at: new Date() });
  }
}

export default new TemplateModel();
