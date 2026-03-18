import { BaseModel } from '@surefy/models/base.model';

class ContactTagRelationModel extends BaseModel {
  constructor() {
    super('contact_tag_relations');
  }

  async findByContact(contactId: string) {
    return this.query().where({ contact_id: contactId });
  }

  async findByTag(tagId: string) {
    return this.query().where({ tag_id: tagId });
  }

  async addTagToContact(contactId: string, tagId: string) {
    const existing = await this.query()
      .where({ contact_id: contactId, tag_id: tagId })
      .first();

    if (existing) {
      return existing;
    }

    return this.create({ contact_id: contactId, tag_id: tagId });
  }

  async removeTagFromContact(contactId: string, tagId: string) {
    return this.query()
      .where({ contact_id: contactId, tag_id: tagId })
      .delete();
  }

  async bulkAddTags(contactId: string, tagIds: string[]) {
    const relations = tagIds.map((tagId) => ({
      contact_id: contactId,
      tag_id: tagId,
    }));

    return this.query()
      .insert(relations)
      .onConflict(['contact_id', 'tag_id'])
      .ignore();
  }

  async bulkRemoveTags(contactId: string, tagIds: string[]) {
    return this.query()
      .where({ contact_id: contactId })
      .whereIn('tag_id', tagIds)
      .delete();
  }

  async getContactsWithTags(contactIds: string[]) {
    return this.db
      .select('ctr.contact_id', this.db.raw('json_agg(ct.*) as tags'))
      .from('contact_tag_relations as ctr')
      .join('contact_tags as ct', 'ct.id', 'ctr.tag_id')
      .whereIn('ctr.contact_id', contactIds)
      .groupBy('ctr.contact_id');
  }

  async getContactIdsByTags(tagIds: string[]) {
    return this.query()
      .whereIn('tag_id', tagIds)
      .select('contact_id')
      .then((rows: any[]) => rows.map((r) => r.contact_id));
  }

  async deleteByTagId(tagId: string) {
    return this.query()
      .where({ tag_id: tagId })
      .delete();
  }
}

export default new ContactTagRelationModel();
