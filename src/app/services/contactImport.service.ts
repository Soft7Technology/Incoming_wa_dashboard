import planUsageService from './planUsage.service';


import type { ContactImportJobData } from '../../queues/contactImport.queue';
import ImportJobModel from '@surefy/console/models/importJob.model';
import ContactModel from '@surefy/console/models/contact.model';
import ContactListModel from '@surefy/console/models/contactList.model';
import ContactListRelationModel from '@surefy/console/models/contactListRelation.model';
import ContactTagRelationModel from '@surefy/console/models/contactTagRelation.model';
import ContactTagModel from '@surefy/console/models/contactTag.model';
import XLSXParserService from '@surefy/console/services/xlsxParser.service';
import * as path from 'path';

const BATCH_SIZE = 500; // Process 500 contacts at a time

export async function processContactImport(data: ContactImportJobData, updateProgress?: (progress: number) => Promise<unknown>) {
  const { jobId,userId,companyId,country_code, filePath,phone_number_id, listName, options } = data;
  console.log(`[Job ${jobId}] Processing contact import from file: ${filePath}`);

  const importJob = await ImportJobModel.findById(jobId);
  if (!importJob || importJob.user_id !== userId || importJob.company_id !== companyId ||
      importJob.phone_number_id !== phone_number_id || importJob.file_path !== filePath) {
    throw new Error('Contact import job not found in the requested account');
  }
  // A completed job may be delivered again after a worker loses its BullMQ lock.
  if (importJob.status === 'completed') return importJob.result;
  if (importJob.status === 'cancelled' || importJob.deleted_at) {
    throw new Error('Contact import job is cancelled or deleted');
  }

  try {
    console.log(`[Job ${jobId}] Starting contact import processing`);
    await ImportJobModel.updateStatus(jobId, 'processing', {
      failed_at: null, error_message: null, error_stack: null,
    });

    // Validate and parse file
    const validation = await XLSXParserService.validateFile(filePath);
    if (!validation.valid) {
      throw new Error(`Invalid XLSX file: ${validation.errors.join(', ')}`);
    }

    // Parse all contacts from file
    const parseResult = await XLSXParserService.parseContactsFromFile(
      filePath,
      country_code,
      options.phoneColumn,
      options.nameColumn,
      options.emailColumn
    );

    console.log(`Contacts Results ${JSON.stringify(parseResult)}`);

    console.log(`[Job ${jobId}] Parsed ${parseResult.contacts.length} contacts from file`);

    // List creation and its job association commit together so retries cannot create orphan lists.
    const list = await ImportJobModel.getOrCreateContactList(jobId, {
      user_id:userId,
      company_id:companyId,
      phone_number_id:phone_number_id,
      country_code:country_code || null,
      name: listName,
      file_name: path.basename(filePath),
      file_path: filePath,
      file_headers: parseResult.headers,
      total_contacts: parseResult.contacts.length + parseResult.invalid,
      valid_contacts: parseResult.valid,
      invalid_contacts: parseResult.invalid,
    });

    // Update job with list_id and total rows
    await ImportJobModel.update(jobId, {
      list_id: list.id,
      total_rows: parseResult.contacts.length + parseResult.invalid,
      file_headers: parseResult.headers,
    });

    console.log(`[Job ${jobId}] Using list: ${list.id}`);

    // Process contacts in batches
    const totalContacts = parseResult.contacts.length;
    const batches = Math.ceil(totalContacts / BATCH_SIZE);

    let successfulCount = 0;
    let failedCount = parseResult.invalid;
    let skippedCount = 0;
    const allErrors: any[] = [...parseResult.errors];

    for (let batchIndex = 0; batchIndex < batches; batchIndex++) {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, totalContacts);
      const batch = parseResult.contacts.slice(start, end);

      console.log(`[Job ${jobId}] Processing batch ${batchIndex + 1}/${batches} (${start}-${end})`);

      // Process each contact in the batch
      for (const contactData of batch) {
        try {
          // Check if contact exists
          let contact = await ContactModel.findOwnedByPhone(userId, contactData.phone_number, phone_number_id, companyId, contactData.country_code);

          if (contact) {
            // Update existing contact
            contact = await ContactModel.update(contact.id, {
              attributes: { ...contact.attributes, ...contactData.attributes },
              name: contactData.name || contact.name,
              email: contactData.email || contact.email,
              country_code: contactData.country_code,
              is_valid: contactData.is_valid,
            });
          } else {
            // Create new contact
            contact = await planUsageService.run(userId, 'Contact', trx => ContactModel.create({
              user_id:userId,
              company_id:companyId,
              country_code: contactData.country_code,
              phone_number_id:phone_number_id,
              name: contactData.attributes?.name || contactData.name || '',
              ...contactData,
              source: 'import',
            }, trx));
          }

          // Add to list
          await ContactListRelationModel.addContactToList(contact.id, list.id);

          // Add tags if specified
          if (options.tagIds && options.tagIds.length > 0) {
            await ContactTagRelationModel.bulkAddTags(userId,contact.id, options.tagIds);

          }

          successfulCount++;
        } catch (error: any) {
          console.error(`[Job ${jobId}] Error processing contact ${contactData.phone_number}:`, error);
          failedCount++;
          allErrors.push({
            phone_number: contactData.phone_number,
            error: error.message,
            row: start + batch.indexOf(contactData) + 1,
          });
        }
      }

      // Update progress after each batch
      const processedRows = end + parseResult.invalid;
      await ImportJobModel.updateProgress(jobId, {
        processed_rows: processedRows,
        successful_rows: successfulCount,
        failed_rows: failedCount,
        skipped_rows: skippedCount,
        errors: allErrors.slice(-100), // Keep last 100 errors
      });

      // Update job progress percentage
      const progressPercentage = Math.round((processedRows / (totalContacts + parseResult.invalid)) * 100);
      await updateProgress?.(progressPercentage);

      console.log(`[Job ${jobId}] Progress: ${progressPercentage}% (${processedRows}/${totalContacts})`);
    }

    // Replayed rows can already have these tags. Count saved relations once per tag,
    // rather than recounting an expanding tag for every contact in a large import.
    for (const tagId of new Set(options.tagIds || [])) {
      await ContactTagModel.updateContactCount(tagId);
    }

    // Update list with final counts
    await ContactListModel.update(list.id, {
      imported_contacts: successfulCount,
      import_failed_contacts: failedCount,
      invalid_phone_numbers: parseResult.invalid,
    });

    // Includes all-invalid files, which do not enter the contact batch loop.
    if (batches === 0) {
      await ImportJobModel.updateProgress(jobId, {
        processed_rows: parseResult.invalid,
        successful_rows: successfulCount,
        failed_rows: failedCount,
        skipped_rows: skippedCount,
        errors: allErrors.slice(-100),
      });
      await updateProgress?.(100);
    }

    // Mark job as completed
    const result = {
      list_id: list.id,
      list_name: listName,
      imported: successfulCount,
      failed: failedCount,
      skipped: skippedCount,
      invalid_count: parseResult.invalid,
      needs_country_count: parseResult.needs_country,
      total: totalContacts + parseResult.invalid,
      errors: allErrors.slice(0, 50), // Return first 50 errors in result
    };

    await ImportJobModel.markAsCompleted(jobId, result);

    console.log(`[Job ${jobId}] Completed successfully. Imported: ${successfulCount}, Failed: ${failedCount}`);

    return result;
  } catch (error: any) {
    console.error(`[Job ${jobId}] Fatal error:`, error);

    // Mark job as failed
    await ImportJobModel.markAsFailed(jobId, error);

    throw error; // Re-throw to let BullMQ handle retry logic
  }
}

