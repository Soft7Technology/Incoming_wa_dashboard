import db from '@surefy/database';
import ContactBulkTagsModel from '../models/contactBulkTags.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';

function validateIds(value: unknown, field: string, limit: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > limit ||
    value.some(
      (id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    )
  ) {
    throw new HTTP400Error({ message: `${field} must contain 1 to ${limit} UUIDs` });
  }
  return [...new Set<string>(value.map((id) => id.toLowerCase()))].sort();
}

export async function addTagsToContacts(
  ownerId: string | undefined,
  companyId: string | undefined,
  actorId: string | undefined,
  contactIdsInput: unknown,
  tagIdsInput: unknown,
) {
  if (!ownerId || !companyId || !actorId) throw new HTTP403Error({ message: 'User and company context are required' });
  const contactIds = validateIds(contactIdsInput, 'contact_ids', 500);
  const tagIds = validateIds(tagIdsInput, 'tag_ids', 50);

  // Ownership checks, assignments and counters commit together or roll back together.
  return db.transaction(async (trx) => {
    // Validate the entire batch before writing. Members can edit only assigned contacts.
    const contacts = await ContactBulkTagsModel.lockOwnedContacts(trx, ownerId, companyId, actorId, contactIds);
    if (contacts.length !== contactIds.length)
      throw new HTTP404Error({
        message: 'One or more contacts were not found in your account or are not assigned to you',
      });
    const tags = await ContactBulkTagsModel.lockOwnedTags(trx, ownerId, companyId, tagIds);
    if (tags.length !== tagIds.length)
      throw new HTTP404Error({ message: 'One or more tags were not found in your account' });

    const added = await ContactBulkTagsModel.insertAssignments(trx, contactIds, tagIds);
    return {
      contact_count: contactIds.length,
      tag_count: tagIds.length,
      added_count: added,
      already_assigned_count: contactIds.length * tagIds.length - added,
    };
  });
}
