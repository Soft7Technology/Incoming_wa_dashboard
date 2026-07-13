import { BaseModel } from '@surefy/models/base.model';
import db from '../../database';
import phoneNumberModel from './phoneNumber.model';

// Helper: build an OR condition for uuid-array column "assigned_to"
// Postgres requires the @> (contains) operator for uuid[] columns
function orAssignedTo(query: any, userId: string) {
  return query.orWhereRaw('assigned_to @> ARRAY[?]::uuid[]', [userId]);
}

class ContactModel extends BaseModel {
  constructor() {
    super('contacts');
  }

  async findByPhone(userId: string, phoneNumber: string) {
    return this.query()
      .where(function(this: any) {
        this.where('user_id', userId);
        orAssignedTo(this, userId);
      })
      .where({ phone_number: phoneNumber })
      .whereNull('deleted_at')
      .first();
  }

  async findByCompany(companyId: string, filters: any = {}) {
    let query = this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at');

    if (filters.is_valid !== undefined) {
      query = query.where({ is_valid: filters.is_valid });
    }

    if (filters.search) {
      query = query.where((builder) => {
        builder
          .where('name', 'ilike', `%${filters.search}%`)
          .orWhere('phone_number', 'like', `%${filters.search}%`)
          .orWhere('email', 'ilike', `%${filters.search}%`);
      });
    }

    return query.orderBy('created_at', 'desc');
  }

  async findByTags(companyId: string, tagIds: string[]) {
    return this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at')
      .whereIn('id', (builder) => {
        builder
          .select('contact_id')
          .from('contact_tag_relations')
          .whereIn('tag_id', tagIds);
      });
  }

  async findByLists(companyId: string, listIds: string[]) {
    return this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at')
      .whereIn('id', (builder) => {
        builder
          .select('contact_id')
          .from('contact_list_relations')
          .whereIn('list_id', listIds);
      });
  }

  async markAsInvalid(contactId: string, reason: string) {
    return this.update(contactId, {
      is_valid: false,
      invalid_reason: reason,
      last_invalid_at: new Date(),
    });
  }

  async incrementMessageCount(contactId: string) {
    return this.query()
      .where({ id: contactId })
      .increment('message_count', 1)
      .update({ last_contacted_at: new Date() });
  }

  async incrementFailedCount(contactId: string) {
    return this.query()
      .where({ id: contactId })
      .increment('failed_count', 1);
  }

  async bulkCreate(contacts: any[]) {
    return this.query().insert(contacts).returning('*');
  }

  async bulkUpsert(userId:string, contacts: any[]) {
    const promises = contacts.map(async (contact) => {
      const existing = await this.findByPhone(userId, contact.phone_number);
      if (existing) {
        return this.update(existing.id, {
          ...contact,
          attributes: { ...existing.attributes, ...contact.attributes },
        });
      }
      return this.create({ ...contact, user_id: userId });
    });
    return Promise.all(promises);
  }

  findWithFilters(userId: string, filters: any, phoneNumberId?: string) {
    console.log("UserId", userId, phoneNumberId)
    let query = this.query();

    if (phoneNumberId) {
      query = query.where('phone_number_id', phoneNumberId)
    }

    if (filters.onlyAssignedToUserId) {
      query = query.whereRaw('assigned_to @> ARRAY[?]::uuid[]', [filters.onlyAssignedToUserId]);
    } else {
      query = query.where(function (this: any) {
        this.where('user_id', userId);

        if (phoneNumberId) {
          this.orWhere('phone_number_id', phoneNumberId);
        }

        orAssignedTo(this, userId);
      });
    }

    query = query.whereNull('deleted_at');

    if (filters.is_valid !== undefined) {
      query = query.where({ is_valid: filters.is_valid });
    }

    if (filters.search) {
      query = query.where((builder: any) => {
        builder
          .where('name', 'ilike', `%${filters.search}%`)
          .orWhere('phone_number', 'like', `%${filters.search}%`)
          .orWhere('email', 'ilike', `%${filters.search}%`);
      });
    }

    // Filter by custom attributes
    if (filters.attributes) {
      for (const [key, value] of Object.entries(filters.attributes)) {
        query = query.whereRaw(`attributes->>'${key}' = ?`, [value]);
      }
    }

    return query;
  }

  async findByUserId(userId: string) {
    return this.query()
      .where(function(this: any) {
        this.where('user_id', userId);
        orAssignedTo(this, userId);
      })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
  }

  async getAssignedUser(userId:string){
    let query = this.query()
    return query.where({user_id:userId}).orWhere({assigned_to:userId}).returning("*")
  }
}

export default new ContactModel();