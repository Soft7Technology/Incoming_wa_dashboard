import { BaseModel } from '@surefy/models/base.model';

class ContactTagModel extends BaseModel {
  constructor() {
    super('contact_tags');
  }

  async findByCompany(companyId: string) {
    return this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at')
      .orderBy('name', 'asc');
  }

  async findByName(companyId: string, name: string) {
    return this.query()
      .where({ company_id: companyId, name })
      .whereNull('deleted_at')
      .first();
  }

  async incrementContactCount(tagId: string, amount: number = 1) {
    return this.query()
      .where({ id: tagId })
      .increment('contact_count', amount);
  }

  async decrementContactCount(tagId: string, amount: number = 1) {
    return this.query()
      .where({ id: tagId })
      .decrement('contact_count', amount);
  }

  async updateContactCount(tagId: string) {
    const count = await this.db
      .from('contact_tag_relations')
      .where({ tag_id: tagId })
      .count('* as count')
      .first();

    return this.update(tagId, { contact_count: count?.count || 0 });
  }

  async findByIds(tagIds: string[]) {
    return this.query().whereIn('id', tagIds);
  }
}

export default new ContactTagModel();
