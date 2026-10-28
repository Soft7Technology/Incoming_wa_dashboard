import db from '@surefy/database';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import phoneNumberModel from '../models/phoneNumber.model';
import planUsage from './planUsage.service';

export interface ImportAccountScope { userId: string; companyId: string; phoneNumberId?: string }

export async function assessContactImport(scope: ImportAccountScope, contacts: Array<{ phone_number: string }>) {
  if (!scope.phoneNumberId) return { checked: false, can_import: false, code: 'PHONE_NUMBER_REQUIRED',
    message: 'Select a WABA number to check the contact allowance before importing.' };
  const phone = await phoneNumberModel.findByPhoneNumberId(scope.phoneNumberId);
  if (!phone || phone.user_id !== scope.userId || phone.company_id !== scope.companyId) {
    throw new HTTP404Error({ message: 'Phone number not found in your account' });
  }
  const unique = [...new Set(contacts.map(contact => contact.phone_number))];
  // Scope matches the worker's identity lookup. Repeats and updates consume no extra capacity.
  const existing = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 500) {
    const rows = await db('contacts').where({ user_id: scope.userId, company_id: scope.companyId, phone_number_id: phone.id })
      .whereNull('deleted_at').whereIn('phone_number', unique.slice(offset, offset + 500)).select('phone_number');
    rows.forEach(row => existing.add(row.phone_number));
  }
  const newContacts = unique.length - existing.size;
  const counts = { unique_contacts: unique.length, duplicate_rows: contacts.length - unique.length,
    existing_contacts: existing.size, new_contacts: newContacts };
  let checked;
  try { checked = await planUsage.assert(scope.userId, 'Contact', 0); }
  catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 403) throw error;
    return { checked: true, feature: 'Contact', ...counts, can_import: false, code: 'PLAN_UNAVAILABLE',
      message: (error as Error).message, required_action: 'UPGRADE_PLAN_OR_BUY_ADDON' };
  }
  const limit = checked.limit == null ? null : Number(checked.limit);
  const remaining = limit === null ? null : Math.max(0, limit - checked.used);
  const excess = remaining === null ? 0 : Math.max(0, newContacts - remaining);
  return { checked: true, feature: 'Contact', limit, used: checked.used, remaining, ...counts,
    excess_contacts: excess, can_import: excess === 0,
    code: excess ? 'CONTACT_IMPORT_LIMIT_EXCEEDED' : 'CONTACT_IMPORT_ALLOWED',
    message: excess
      ? `This file would add ${newContacts} new contacts, but your plan has room for ${remaining}. Remove ${excess} new contacts or increase your contact allowance before importing.`
      : `This file would add ${newContacts} new contacts and update ${existing.size} existing contacts.`,
    ...(excess ? { required_action: 'REDUCE_FILE_OR_BUY_ADDON' } : {}),
  };
}

export function requireContactImportCapacity(assessment: Awaited<ReturnType<typeof assessContactImport>>) {
  if (!assessment.can_import) throw new HTTP403Error({ message: assessment.message, details: assessment });
}
