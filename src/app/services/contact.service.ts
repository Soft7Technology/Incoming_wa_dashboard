import ContactModel from '../models/contact.model';
import ContactTagModel from '../models/contactTag.model';
import ContactTagRelationModel from '../models/contactTagRelation.model';
import ContactListModel from '../models/contactList.model';
import ContactListRelationModel from '../models/contactListRelation.model';
import ImportJobModel from '../models/importJob.model';
import XLSXParserService from './xlsxParser.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { contactImportQueue } from '../../queues/contactImport.queue';
import * as fs from 'fs';
import * as path from 'path';
import { filter } from 'lodash';

class ContactService {
  /**
   * Create a new contact
   */
  async createContact(companyId: string,userId:string, data: any) {
    // Check if contact already exists
    const existing = await ContactModel.findByPhone(companyId,userId, data.phone_number);
    if (existing) {
      throw new HTTP400Error({ message: 'Contact with this phone number already exists' });
    }

    const contact = await ContactModel.create({
      company_id: companyId,
      user_id:userId,
      phone_number: data.phone_number,
      name: data.name,
      email: data.email,
      attributes: data.attributes || {},
      notes: data.notes,
    });

    // Add tags if provided
    if (data.tag_ids && data.tag_ids.length > 0) {
      await this.addTagsToContact(contact.id, data.tag_ids);
    }

    return contact;
  }

  /**
   * Get all contacts for a company
   */
  async getContacts(companyId: string,userId:string, filters: any = {}) {
    let query = ContactModel.findWithFilters(companyId,userId, filters);

    // Filter by tags
    if (filters.tag_ids && filters.tag_ids.length > 0) {
      const contactIds = await ContactTagRelationModel.getContactIdsByTags(filters.tag_ids);
      query = query.whereIn('id', contactIds);
    }

    // Filter by lists
    if (filters.list_ids && filters.list_ids.length > 0) {
      const contactIds = await ContactListRelationModel.getContactIdsByLists(filters.list_ids);
      query = query.whereIn('id', contactIds);
    }

    // Get total count before pagination
    const countQuery = query.clone();
    const totalResult = await countQuery.count('* as count').first();
    const total = parseInt(String(totalResult?.count || 0));

    // Pagination
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 20;
    const offset = (page - 1) * limit;

    const contacts = await query.limit(limit).offset(offset);

    // Get tags for each contact
    if (contacts.length > 0) {
      const contactIds = contacts.map((c: any) => c.id);
      const tagsData = await ContactTagRelationModel.getContactsWithTags(contactIds);

      const tagsMap = new Map();
      tagsData.forEach((item: any) => {
        tagsMap.set(item.contact_id, item.tags);
      });

      contacts.forEach((contact: any) => {
        contact.tags = tagsMap.get(contact.id) || [];
      });
    }

    return {
      contacts,
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get contact by ID
   */
  async getContactById(contactId: string) {
    const contact = await ContactModel.findById(contactId);
    if (!contact) {
      throw new HTTP404Error({ message: 'Contact not found' });
    }

    // Get tags
    const tagRelations = await ContactTagRelationModel.findByContact(contactId);
    const tagIds = tagRelations.map((r) => r.tag_id);

    if (tagIds.length > 0) {
      contact.tags = await ContactTagModel.findByIds(tagIds);
    } else {
      contact.tags = [];
    }

    return contact;
  }

  /**
   * Update contact
   */
  async updateContact(contactId: string, data: any) {
    const contact = await ContactModel.findById(contactId);
    if (!contact) {
      throw new HTTP404Error({ message: 'Contact not found' });
    }

    const updated = await ContactModel.update(contactId, {
      name: data.name,
      email: data.email,
      attributes: data.attributes ? { ...contact.attributes, ...data.attributes } : contact.attributes,
      notes: data.notes,
    });

    // Update tags if provided
    if (data.tag_ids !== undefined) {
      await this.syncContactTags(contactId, data.tag_ids);
    }

    return updated;
  }

  /**
   * Delete contact (soft delete)
   */
  async deleteContact(contactId: string) {
    const contact = await ContactModel.findById(contactId);
    if (!contact) {
      throw new HTTP404Error({ message: 'Contact not found' });
    }

    await ContactModel.delete(contactId);
  }

  /**
   * Queue contact import job (async processing)
   */
  async queueContactImport(
    companyId: string,
    userId:string,
    filePath: string,
    listName: string,
    options: {
      phoneColumn?: string;
      nameColumn?: string;
      emailColumn?: string;
      tagIds?: string[];
    } = {}
  ) {
    // Quick validation of file before queuing
    const validation = await XLSXParserService.validateFile(filePath);
    if (!validation.valid) {
      throw new HTTP400Error({ message: `Invalid XLSX file: ${validation.errors.join(', ')}` });
    }

    // Get basic file info for job tracking
    const preview = await XLSXParserService.getFilePreview(filePath);
    console.log(`File preview for import job: ${JSON.stringify(preview)}`);

    // Create import job record in database
    const importJob = await ImportJobModel.create({
      company_id: companyId,
      user_id:userId,
      job_type: 'contact_import',
      status: 'queued',
      file_name: path.basename(filePath),
      file_path: filePath,
      file_headers: preview.headers,
      total_rows: preview.total_rows,
      import_options: {
        list_name: listName,
        phone_column: options.phoneColumn,
        name_column: options.nameColumn,
        email_column: options.emailColumn,
        tag_ids: options.tagIds,
      },
    });

    console.log(`Queued contact import job ${JSON.stringify(importJob)} for company ${companyId}`);

    // Add job to BullMQ queue
    await contactImportQueue.add(
      `contact-import-${importJob.id}`,
      {
        jobId: importJob.id,
        companyId,
        userId,
        filePath,
        listName,
        options,
      },
      {
        jobId: importJob.id, // Use database job ID as BullMQ job ID for tracking
      }
    );

    return importJob;
  }

  /**
   * Get import job status
   */
  async getImportJobStatus(jobId: string) {
    const job = await ImportJobModel.findById(jobId);
    if (!job) {
      throw new HTTP404Error({ message: 'Import job not found' });
    }

    // Get BullMQ job details if available
    const bullJob = await contactImportQueue.getJob(jobId);

    return {
      id: job.id,
      status: job.status,
      progress_percentage: job.progress_percentage,
      total_rows: job.total_rows,
      processed_rows: job.processed_rows,
      successful_rows: job.successful_rows,
      failed_rows: job.failed_rows,
      skipped_rows: job.skipped_rows,
      list_id: job.list_id,
      errors: job.errors,
      result: job.result,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
      failed_at: job.failed_at,
      error_message: job.error_message,
      bull_job_state: bullJob ? await bullJob.getState() : null,
    };
  }

  /**
   * Get all import jobs for a company
   */
  async getImportJobs(companyId: string, filters: any = {}) {
    return ImportJobModel.findByCompany(companyId, filters);
  }

  /**
   * Legacy synchronous import (kept for backward compatibility or small imports)
   * @deprecated Use queueContactImport for large imports
   */
  async importContactsFromXLSX(
    companyId: string,
    userId:string,
    filePath: string,
    listName: string,
    options: {
      phoneColumn?: string;
      nameColumn?: string;
      emailColumn?: string;
      tagIds?: string[];
    } = {}
  ) {
    // Validate file
    const validation = await XLSXParserService.validateFile(filePath);
    if (!validation.valid) {
      throw new HTTP400Error({ message: `Invalid XLSX file: ${validation.errors.join(', ')}` });
    }

    // Parse file
    const parseResult = await XLSXParserService.parseContactsFromFile(
      filePath,
      options.phoneColumn,
      options.nameColumn,
      options.emailColumn
    );

    // Create contact list
    const list = await ContactListModel.create({
      company_id: companyId,
      name: listName,
      file_name: path.basename(filePath),
      file_path: filePath,
      file_headers: parseResult.headers,
      total_contacts: parseResult.contacts.length,
      valid_contacts: parseResult.valid,
      invalid_contacts: parseResult.invalid,
    });

    const importedContacts = [];
    const skippedContacts = [];

    // Import contacts
    for (const contactData of parseResult.contacts) {

      try {
        // Check if contact exists
        let contact = await ContactModel.findByPhone(companyId,userId, contactData.phone_number);

        if (contact) {
          // Update existing contact attributes
          contact = await ContactModel.update(contact.id, {
            attributes: { ...contact.attributes, ...contactData.attributes },
            name: contactData.name || contact.name,
            email: contactData.email || contact.email,
          });
        } else {
          // Create new contact
          contact = await ContactModel.create({
            company_id: companyId,
            name: contactData.attributes.name || contactData.name || '',
            ...contactData,
          });
        }

        // Add to list
        await ContactListRelationModel.addContactToList(contact.id, list.id);

        // Add tags if specified
        if (options.tagIds && options.tagIds.length > 0) {
          await ContactTagRelationModel.bulkAddTags(contact.id, options.tagIds);

          // Update tag counts
          for (const tagId of options.tagIds) {
            await ContactTagModel.incrementContactCount(tagId);
          }
        }

        importedContacts.push(contact);
      } catch (error: any) {
        skippedContacts.push({
          phone_number: contactData.phone_number,
          error: error.message,
        });
      }
    }

    return {
      list,
      imported: importedContacts.length,
      skipped: skippedContacts.length,
      errors: parseResult.errors,
      skipped_contacts: skippedContacts,
    };
  }

  /**
   * Get file preview before import
   */
  async getXLSXPreview(filePath: string) {
    return XLSXParserService.getFilePreview(filePath);
  }

  /**
   * Add tags to contact
   */
  async addTagsToContact(contactId: string, tagIds: string[]) {
    await ContactTagRelationModel.bulkAddTags(contactId, tagIds);

    // Update tag counts
    for (const tagId of tagIds) {
      await ContactTagModel.incrementContactCount(tagId);
    }
  }

  /**
   * Remove tags from contact
   */
  async removeTagsFromContact(contactId: string, tagIds: string[]) {
    await ContactTagRelationModel.bulkRemoveTags(contactId, tagIds);

    // Update tag counts
    for (const tagId of tagIds) {
      await ContactTagModel.decrementContactCount(tagId);
    }
  }

  /**
   * Sync contact tags (replace all tags)
   */
  async syncContactTags(contactId: string, tagIds: string[]) {
    // Get existing tags
    const existing = await ContactTagRelationModel.findByContact(contactId);
    const existingTagIds = existing.map((r) => r.tag_id);

    // Find tags to add and remove
    const toAdd = tagIds.filter((id) => !existingTagIds.includes(id));
    const toRemove = existingTagIds.filter((id) => !tagIds.includes(id));

    // Add new tags
    if (toAdd.length > 0) {
      await this.addTagsToContact(contactId, toAdd);
    }

    // Remove old tags
    if (toRemove.length > 0) {
      await this.removeTagsFromContact(contactId, toRemove);
    }
  }

  /**
   * Mark contact as invalid
   */
  async markContactAsInvalid(contactId: string, reason: string, details?: string) {
    const contact = await ContactModel.markAsInvalid(contactId, reason);
    return contact;
  }

  /**
   * Get contacts by filters (for campaign targeting)
   */
  async getContactsByFilters(companyId: string,userId:string, filters: any) {
    let query = ContactModel.findWithFilters(companyId,userId, filters);

    // Exclude invalid numbers by default
    if (filters.exclude_invalid !== false) {
      query = query.where({ is_valid: true });
    }

    // Filter by tags (OR condition)
    if (filters.tag_ids && filters.tag_ids.length > 0) {
      const contactIds = await ContactTagRelationModel.getContactIdsByTags(filters.tag_ids);
      query = query.whereIn('contacts.id', contactIds);
    }

    // Filter by lists (OR condition)
    // if (filters.list_ids && filters.list_ids.length > 0) {
    //   console.log("Filters",filters.list_ids.length)
    //   const contactIds = await ContactListRelationModel.getContactIdsByLists(filters.list_ids);
    //   console.log("Contacts",contactIds)
    //   query = query.whereIn('id', contactIds);
    // }
    if (filters.list_ids && filters.list_ids.length > 0) {
      const contactIds =
        await ContactListRelationModel.getContactIdsByLists(filters.list_ids);

      if (!contactIds || contactIds.length === 0) {
        query.whereRaw('false'); // return empty safely
      } else {
        query.whereRaw(
          'contacts.id = ANY(?::uuid[])',
          [contactIds]
        );
      }
    }



    // Filter by custom attributes
    if (filters.attributes) {
      for (const [key, value] of Object.entries(filters.attributes)) {
        query = query.whereRaw(`attributes->>'${key}' = ?`, [value]);
      }
    }

    return query;
  }

  /**
   * Tag Management
   */
  async createTag(companyId: string, data: any) {
    const existing = await ContactTagModel.findByName(companyId, data.name);
    if (existing) {
      throw new HTTP400Error({ message: 'Tag with this name already exists' });
    }

    return ContactTagModel.create({
      company_id: companyId,
      name: data.name,
      color: data.color || '#3B82F6',
      description: data.description,
    });
  }

  async getTags(companyId: string) {
    return ContactTagModel.findByCompany(companyId);
  }

  async updateTag(tagId: string, data: any) {
    return ContactTagModel.update(tagId, {
      name: data.name,
      color: data.color,
      description: data.description,
    });
  }

  async deleteTag(tagId: string) {
    // Remove all tag relations
    await ContactTagRelationModel.deleteByTagId(tagId);

    // Delete tag
    await ContactTagModel.delete(tagId);
  }

  /**
   * List Management
   */
  async getLists(companyId: string,userId:string) {
    return ContactListModel.findByCompany(companyId,userId);
  }

  async getListById(listId: string) {
    const list = await ContactListModel.findById(listId);
    if (!list) {
      throw new HTTP404Error({ message: 'Contact list not found' });
    }
    return list;
  }

  async getListContacts(listId: string, filters: any = {}) {
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 20;
    const offset = (page - 1) * limit;

    let contacts = await ContactListRelationModel.getContactsInList(listId, filters);

    const total = contacts.length;
    contacts = contacts.slice(offset, offset + limit);

    return { contacts, total, page, limit };
  }

  async deleteList(listId: string) {
    // Remove all list relations
    await ContactListRelationModel.deleteByListId(listId);

    // Delete list
    await ContactListModel.delete(listId);
  }

  /**
   * Generate sample XLSX template for contacts import
   */
  async generateSampleTemplate(): Promise<Buffer> {
    const XLSX = require('xlsx');

    // Sample data to include in the template
    const sampleData = [
      {
        phone_number: '+1234567890',
        name: 'John Doe',
        email: 'john@example.com',
      },
      {
        phone_number: '+0987654321',
        name: 'Jane Smith',
        email: 'jane@example.com',
      },
      {
        phone_number: '+1122334455',
        name: 'Bob Johnson',
        email: 'bob@example.com',
      },
    ];

    // Create worksheet from sample data
    const worksheet = XLSX.utils.json_to_sheet(sampleData);

    // Set column widths
    worksheet['!cols'] = [
      { wch: 20 }, // phone_number
      { wch: 25 }, // name
      { wch: 30 }, // email
    ];

    // Create workbook
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Contacts');

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    return buffer;
  }
}

export default new ContactService();