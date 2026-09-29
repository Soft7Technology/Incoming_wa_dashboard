import { buildRecipient } from './importPhone';
/** Compare international numbers without display punctuation; never infer a country code. */
export const campaignPhoneIdentity = (phone: string): string => phone.replace(/[^0-9]/g, '');

/** Keep the first contact and its template attributes for each recipient number. */
export function uniqueCampaignRecipients<T extends { phone_number: string; country_code?: string | null }>(contacts: T[]): T[] {
  const seen = new Set<string>();
  return contacts.filter(contact => {
    const number = contact.country_code ? buildRecipient(contact.phone_number, contact.country_code) : campaignPhoneIdentity(contact.phone_number || '');
    if (!number || seen.has(number)) return false;
    seen.add(number);
    return true;
  });
}
