import { parseStoredContactPhone } from '../utils/importPhone';
import { countryCodeFilterValues } from '../utils/countryCode';
import { BaseModel } from '@surefy/models/base.model';
import db from '../../database';
import phoneNumberModel from './phoneNumber.model';
import { Knex } from 'knex';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

function parseImportedPhone(value: unknown, code = '') {
  try { return parseStoredContactPhone(value, code); }
  catch (error: any) { throw new HTTP400Error({ message: error.message }); }
}

export function normalizeContactPhone(value: unknown): string {
  const digits = String(value ?? '').trim().replace(/[+\s()-]/g, '');
  if (!/^\d+$/.test(digits)) {
    throw new HTTP400Error({ message: 'A valid phone number is required' });
  }
  return digits;
}

// Helper: build an OR condition for uuid-array column "assigned_to"
// Postgres requires the @> (contains) operator for uuid[] columns
function orAssignedTo(query: any, userId: string) {
  return query.orWhereRaw('assigned_to @> ARRAY[?]::uuid[]', [userId]);
}

class ContactModel extends BaseModel {
  constructor() {
    super('contacts');
  }

  async findCampaignPhoneCandidates(userId: string, companyId: string, numbers: string[]) {
    if (!numbers.length) return [];
    const suffixes = [...new Set(numbers.map(value => String(value).replace(/[^0-9]/g, '').replace(/^00/, '')))];
    return this.query().where({ user_id: userId, company_id: companyId }).whereNull('deleted_at')
      .andWhere(builder => {
        for (const digits of suffixes) {
          // Match local digits against saved international numbers, and vice versa.
          builder.orWhereRaw("regexp_replace(phone_number, '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
            .orWhereRaw("? LIKE '%' || regexp_replace(phone_number, '[^0-9]', '', 'g')", [digits]);
        }
      });
  }

  async findCampaignRecipients(ids: string[]) {
    if (!ids.length) return [];
    return this.query()
      .whereIn('id', ids)
      .select('id', 'name', 'phone_number', 'country_code', 'is_valid', 'invalid_reason');
  }

  async create(data: any, trx?: Knex.Transaction): Promise<any> {
    if (!data.user_id || !data.company_id) throw new HTTP400Error({ message: 'User and company context are required' });
    if (data.phone_number_id) {
      const phone = await phoneNumberModel.findByPhoneNumberId(data.phone_number_id);
      if (!phone || phone.user_id !== data.user_id || phone.company_id !== data.company_id) {
        throw new HTTP400Error({ message: 'Phone number does not belong to this account' });
      }
      data = { ...data, phone_number_id: phone.id };
    }
    const normalized = { ...data, ...parseImportedPhone(data.phone_number, data.country_code || '') };
    const insert = async (transaction: Knex.Transaction) => {
      // Serialize creates for the same owner, business number and normalized phone.
      const key = JSON.stringify([data.company_id, data.user_id, data.phone_number_id ?? null, normalized.country_code, normalized.phone_number]);
      await transaction.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
      const existing = await transaction('contacts')
        .where({ user_id: data.user_id, company_id: data.company_id, phone_number_id: data.phone_number_id ?? null })
        .whereNull('deleted_at')
        .where({ phone_number: normalized.phone_number })
        .first();
      if (existing) {
        throw new HTTP400Error({ message: 'Cannot create contact: this phone number already exists under the same user and phone number ID' });
      }
      return super.create(normalized, transaction);
    };
    return trx ? insert(trx) : this.db.transaction(insert);
  }

  async update(id: any, data: any) {
    if (data.phone_number === undefined && data.country_code === undefined) return super.update(id, data);
    const existing = await this.findById(id);
    return super.update(id, { ...data, ...parseImportedPhone(
      data.phone_number ?? (data.country_code && !existing.country_code ? existing.phone_number.replace(/^\+/, '') : existing.phone_number), data.country_code ?? existing.country_code ?? '',
    ) });
  }

  async findOrCreateIncoming(data: any) {
    if (!data.user_id || !data.company_id) throw new HTTP400Error({ message: 'User and company context are required' });
    data = { ...data, ...(data.country_code ? parseImportedPhone(data.phone_number, data.country_code) : parseImportedPhone(data.phone_number)) };
    const profileName = typeof data.name === 'string' ? data.name.trim() : '';
    const isPhoneName = (name: string) => /^[+\d\s().-]+$/.test(name) && /\d/.test(name);
    const refreshName = async (contact: any) => {
      const currentName = typeof contact.name === 'string' ? contact.name.trim() : '';
      if (!profileName || isPhoneName(profileName) || (currentName && !isPhoneName(currentName))) return contact;
      // Compare the old name so a concurrent manual edit is not overwritten.
      const [updated] = await this.query()
        .where({ id: contact.id, user_id: data.user_id, company_id: data.company_id,
          phone_number_id: data.phone_number_id ?? null, name: contact.name ?? null })
        .whereNull('deleted_at')
        .update({ name: profileName, updated_at: new Date() })
        .returning('*');
      return updated || contact;
    };
    const existing = await this.findOwnedByPhone(data.user_id, data.phone_number, data.phone_number_id, data.company_id, data.country_code);
    if (existing) return refreshName(existing);
    try {
      return await this.create({ ...data, name: profileName || data.phone_number });
    } catch (error) {
      // Another incoming request may have inserted this contact while we waited.
      if (error instanceof HTTP400Error) {
        const concurrent = await this.findOwnedByPhone(data.user_id, data.phone_number, data.phone_number_id, data.company_id, data.country_code);
        if (concurrent) return refreshName(concurrent);
      }
      throw error;
    }
  }

  async findOwnedByPhone(userId: string, phoneNumber: string, phoneNumberId?: string | null, companyId?: string, countryCode?: string | null) {
    const identity = countryCode ? parseImportedPhone(phoneNumber, countryCode) : parseImportedPhone(phoneNumber);
    const query = this.query()
      .where('user_id', userId)
      .where('phone_number_id', phoneNumberId ?? null)
      .whereNull('deleted_at')
      .where({ phone_number: identity.phone_number })
      .first();
    if (companyId) query.where('company_id', companyId);
    return query;
  }

  async findByPhone(userId: string, phoneNumber: string, countryCode?: string | null) {
    const identity = countryCode ? parseImportedPhone(phoneNumber, countryCode) : parseImportedPhone(phoneNumber);
    return this.query()
      .where(function (this: any) {
        this.where('user_id', userId);
        orAssignedTo(this, userId);
      })
      .where({ phone_number: identity.phone_number })
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
    return this.query().insert(contacts.map(contact => ({
      ...contact, ...parseImportedPhone(contact.phone_number, contact.country_code || ''),
    }))).returning('*');
  }

  async bulkUpsert(userId: string, contacts: any[]) {
    const promises = contacts.map(async (contact) => {
      const existing = await this.findOwnedByPhone(userId, contact.phone_number, contact.phone_number_id, contact.company_id, contact.country_code);
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

  /** Sort before pagination so the latest conversation can appear on the first page. */
  orderByLastMessage(query: Knex.QueryBuilder, direction: 'asc' | 'desc') {
    return query.select('contacts.*').joinRaw(`LEFT JOIN LATERAL (
      SELECT m.updated_at AS last_message_at
      FROM messages m
      WHERE m.company_id = contacts.company_id
        AND m.user_id = contacts.user_id
        AND m.phone_number_id = contacts.phone_number_id
        AND CASE WHEN m.direction = 'inbound'
          THEN regexp_replace(m.from_phone, '[^0-9]', '', 'g')
          ELSE regexp_replace(m.to_phone, '[^0-9]', '', 'g') END =
          CASE
            WHEN contacts.phone_number LIKE '00%'
            THEN substring(regexp_replace(contacts.phone_number, '[^0-9]', '', 'g') FROM 3)
            WHEN contacts.phone_number LIKE '+%' OR COALESCE(contacts.country_code, '') = ''
            THEN regexp_replace(contacts.phone_number, '[^0-9]', '', 'g')
            ELSE regexp_replace(contacts.country_code || contacts.phone_number, '[^0-9]', '', 'g')
          END
      ORDER BY m.created_at DESC NULLS LAST, m.id DESC LIMIT 1
    ) AS contact_activity ON true`)
      .select('contact_activity.last_message_at')
      .orderBy('contact_activity.last_message_at', direction, 'last')
      .orderBy('contacts.id', 'asc');
  }

  findWithFilters(
    userId: string,
    filters: any = {},
    phoneNumberId?: string
  ) {
    console.log("=================================");
    console.log("findWithFilters");
    console.log("User ID:", userId);
    console.log("Phone Number ID:", phoneNumberId);
    console.log("Filters:", JSON.stringify(filters, null, 2));
    console.log("=================================");

    let query = this.query();

    // Filter by phone number
    if (phoneNumberId) {
      query.where("phone_number_id", phoneNumberId);
    }

    if (!userId) throw new HTTP400Error({ message: 'User context is required' });
    query.where('contacts.user_id', userId);
    if (filters.onlyAssignedToUserId) {
      query.whereRaw('assigned_to @> ARRAY[?]::uuid[]', [filters.onlyAssignedToUserId]);
    }

    // Ignore deleted contacts
    query.whereNull("deleted_at");

    // Keep the union of country/tag matches inside the ownership and deletion scope.
    // An IN subquery returns each contact once, even if it has multiple matching tags.
    if (filters.country_code !== undefined || filters.tag_ids?.length) {
      query.where((matching) => {
        if (filters.country_code !== undefined) {
          matching.whereIn('contacts.country_code', countryCodeFilterValues(filters.country_code));
        }
        if (filters.tag_ids?.length) {
          const method = filters.countryTagMatch === 'any' && filters.country_code !== undefined
            ? 'orWhereIn' : 'whereIn';
          matching[method]('contacts.id', (builder) => {
            builder.select('ctr.contact_id')
              .from('contact_tag_relations as ctr')
              .whereIn('ctr.tag_id', filters.tag_ids);
          });
        }
      });
    }

    if (filters.is_valid !== undefined) {
      query.where("is_valid", filters.is_valid);
    }

    // Search filter
    if (filters.search) {
      query.where((builder: any) => {
        builder
          .where("name", "ilike", `%${filters.search}%`)
          .orWhere("phone_number", "ilike", `%${filters.search}%`)
          .orWhere("email", "ilike", `%${filters.search}%`);
      });
    }

    // Custom attributes filter
    if (filters.attributes) {
      Object.entries(filters.attributes).forEach(
        ([key, value]) => {
          query.whereRaw(
            `attributes->>? = ?`,
            [key, value]
          );
        }
      );
    }

    console.log(
      "Generated Query:",
      query.clone().toSQL().toNative()
    );

    return query;
  }

  async findByUserId(userId: string) {
    return this.query()
      .where(function (this: any) {
        this.where('user_id', userId);
        orAssignedTo(this, userId);
      })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
  }

  async getAssignedUser(userId: string) {
    let query = this.query()
    return query.where({ user_id: userId }).orWhere({ assigned_to: userId }).returning("*")
  }

  async delete(id: string | number | any) {
    const now = new Date();
    return this.query().where({ id }).whereNull('deleted_at')
      .update({ deleted_at: now, updated_at: now });
  }

  async bulkDelete(companyId: string, ids: string[], userId: string, assignedUserId?: string) {
    if (!companyId || !userId) throw new HTTP400Error({ message: 'User and company context are required' });
    const query = this.query().where({ company_id: companyId, user_id: userId })
      .whereIn('id', ids).whereNull('deleted_at');
    if (assignedUserId) query.whereRaw('assigned_to @> ARRAY[?]::uuid[]', [assignedUserId]);
    // Preserve referenced messages, inbound receipts, and preference audit history.
    const now = new Date();
    return query.update({ deleted_at: now, updated_at: now });
  }

  async findByUserPhoneNumber(userId: string, phoneNumber: string) {
    return this.query()
      .where({ user_id: userId })
      .where({ phone_number: parseImportedPhone(phoneNumber).phone_number })
      .whereNull('deleted_at')
      .first();
  }
}

export default new ContactModel();
