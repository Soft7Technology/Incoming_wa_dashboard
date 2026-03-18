import { BaseModel } from '@surefy/models/base.model';

class ContactListRelationModel extends BaseModel {
  constructor() {
    super('contact_list_relations');
  }

  async findByContact(contactId: string) {
    return this.query().where({ contact_id: contactId });
  }

  async findByList(listId: string) {
    return this.query().where({ list_id: listId });
  }

  async addContactToList(contactId: string, listId: string) {
    const existing = await this.query()
      .where({ contact_id: contactId, list_id: listId })
      .first();

    if (existing) {
      return existing;
    }

    return this.create({ contact_id: contactId, list_id: listId });
  }

  async removeContactFromList(contactId: string, listId: string) {
    return this.query()
      .where({ contact_id: contactId, list_id: listId })
      .delete();
  }

  async bulkAddContacts(listId: string, contactIds: string[]) {
    const relations = contactIds.map((contactId) => ({
      contact_id: contactId,
      list_id: listId,
    }));

    return this.query()
      .insert(relations)
      .onConflict(['contact_id', 'list_id'])
      .ignore();
  }

  async getContactsInList(listId: string, filters: any = {}) {
    let query = this.db
      .select('c.*')
      .from('contacts as c')
      .join('contact_list_relations as clr', 'clr.contact_id', 'c.id')
      .where('clr.list_id', listId)
      .whereNull('c.deleted_at');

    if (filters.is_valid !== undefined) {
      query = query.where('c.is_valid', filters.is_valid);
    }

    return query.orderBy('c.created_at', 'desc');
  }

  async getContactIdsByLists(listIds: string[]) {
    return this.query()
      .whereIn('list_id', listIds)
      .select('contact_id')
      .then((rows: any[]) => rows.map((r) => r.contact_id));
  }

  async deleteByListId(listId: string) {
    return this.query()
      .where({ list_id: listId })
      .delete();
  }
}

export default new ContactListRelationModel();
