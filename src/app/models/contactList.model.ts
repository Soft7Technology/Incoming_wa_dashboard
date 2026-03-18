import { BaseModel } from '@surefy/models/base.model';

class ContactListModel extends BaseModel {
  constructor() {
    super('contact_lists');
  }

  async findByCompany(companyId: string) {
    return this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
  }

  async findByName(companyId: string, name: string) {
    return this.query()
      .where({ company_id: companyId, name })
      .whereNull('deleted_at')
      .first();
  }

  async updateCounts(listId: string, counts: { total?: number; valid?: number; invalid?: number }) {
    const updateData: any = {};

    if (counts.total !== undefined) updateData.total_contacts = counts.total;
    if (counts.valid !== undefined) updateData.valid_contacts = counts.valid;
    if (counts.invalid !== undefined) updateData.invalid_contacts = counts.invalid;

    return this.update(listId, updateData);
  }

  async incrementCounts(listId: string, field: 'total_contacts' | 'valid_contacts' | 'invalid_contacts', amount: number = 1) {
    return this.query()
      .where({ id: listId })
      .increment(field, amount);
  }
}

export default new ContactListModel();
