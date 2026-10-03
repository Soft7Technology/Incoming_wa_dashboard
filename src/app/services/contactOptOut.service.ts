import { campaignRecipientNumber } from '../utils/campaignPhone';
import db from '@surefy/database';
import phones from '../models/phoneNumber.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';

export interface OptOutScope {
  companyId: string;
  ownerId: string;
  actorId: string;
}
interface PhoneContext {
  id: string;
  company_id: string;
  user_id: string;
  opt_in_keywords?: unknown;
  opt_out_keywords?: unknown;
}
interface ContactIdentity {
  id: string;
  company_id: string;
  user_id: string;
  phone_number_id: string | null;
  country_code: string;
  phone_number: string;
}
interface KeywordSettings { opt_in_keywords: string[]; opt_out_keywords: string[] }
interface IncomingCommand {
  text?: { body?: string };
  interactive?: { button_reply?: { id?: string }; list_reply?: { id?: string } };
  button?: { payload?: string };
}
const MAX_KEYWORDS = 30;
const MAX_KEYWORD_LENGTH = 80;
export const normalizeKeyword = (text: string): string =>
  text.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();

export function validateKeywords(body: unknown): KeywordSettings {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HTTP400Error({ message: 'Provide opt_in_keywords and opt_out_keywords arrays' });
  }
  const parse = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > MAX_KEYWORDS ||
        value.some(word => typeof word !== 'string' || word.length > MAX_KEYWORD_LENGTH || !normalizeKeyword(word) || normalizeKeyword(word).length > MAX_KEYWORD_LENGTH)) {
      throw new HTTP400Error({ message: 'Keywords must be arrays of up to 30 non-empty strings (maximum 80 characters each)' });
    }
    return [...new Set<string>(value.map(normalizeKeyword))];
  };
  const input = body as Record<string, unknown>;
  const opt_in_keywords = parse(input.opt_in_keywords);
  const opt_out_keywords = parse(input.opt_out_keywords);
  if (opt_in_keywords.some(word => opt_out_keywords.includes(word))) {
    throw new HTTP400Error({ message: 'Opt-in and opt-out keywords cannot overlap' });
  }
  return { opt_in_keywords, opt_out_keywords };
}

// Legacy JSON strings and malformed stored values must not break inbound delivery.
function storedKeywords(value: unknown, defaults: string[]): string[] {
  if (value === undefined || value === null) return defaults;
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((word): word is string => typeof word === 'string').map(normalizeKeyword).filter(Boolean) : [];
  } catch { return []; }
}
export function keywordDecision(phone: PhoneContext, incoming: IncomingCommand): boolean | undefined {
  const value = incoming?.text?.body || incoming?.interactive?.button_reply?.id || incoming?.interactive?.list_reply?.id || incoming?.button?.payload;
  if (typeof value !== 'string') return undefined;
  const text = normalizeKeyword(value);
  if (storedKeywords(phone.opt_out_keywords, ['STOP', 'UNSUBSCRIBE']).includes(text)) return true;
  if (storedKeywords(phone.opt_in_keywords, ['START']).includes(text)) return false;
  return undefined;
}
function assertScope(scope: OptOutScope): void {
  if (!scope.companyId || !scope.ownerId || !scope.actorId) {
    throw new HTTP400Error({ message: 'Authenticated company and user context are required' });
  }
}
class ContactOptOutService {
  private async ownedPhone(scope: OptOutScope, phoneNumberId: string): Promise<PhoneContext> {
    assertScope(scope);
    const phone = await phones.findByPhoneNumberId(phoneNumberId);
    if (!phone || phone.deleted_at || phone.company_id !== scope.companyId || phone.user_id !== scope.ownerId) {
      throw new HTTP404Error({ message: 'Business phone number not found in your account' });
    }
    return phone;
  }

  async getKeywords(scope: OptOutScope, phoneNumberId: string) {
    const phone = await this.ownedPhone(scope, phoneNumberId);
    return { phone_number_id: phone.id,
      opt_in_keywords: storedKeywords(phone.opt_in_keywords, ['START']),
      opt_out_keywords: storedKeywords(phone.opt_out_keywords, ['STOP', 'UNSUBSCRIBE']) };
  }

  async updateKeywords(scope: OptOutScope, phoneNumberId: string, body: unknown) {
    const keywords = validateKeywords(body);
    const phone = await this.ownedPhone(scope, phoneNumberId);
    const count = await db('phone_numbers').where({ id: phone.id, company_id: scope.companyId, user_id: scope.ownerId })
      .whereNull('deleted_at').update({
        opt_in_keywords: JSON.stringify(keywords.opt_in_keywords),
        opt_out_keywords: JSON.stringify(keywords.opt_out_keywords),
      });
    if (!count) throw new HTTP404Error({ message: 'Business phone number not found in your account' });
    return { phone_number_id: phone.id, ...keywords };
  }

  async updateContact(scope: OptOutScope, id: string, optedOut: unknown) {
    assertScope(scope);
    if (typeof optedOut !== 'boolean') throw new HTTP400Error({ message: 'is_opted_out must be true or false' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new HTTP400Error({ message: 'Invalid contact ID' });
    }
    const query = db('contacts').where({ id, company_id: scope.companyId, user_id: scope.ownerId }).whereNull('deleted_at');
    if (scope.actorId !== scope.ownerId) query.whereRaw('assigned_to @> ARRAY[?]::uuid[]', [scope.actorId]);
    const contact = await query.first();
    if (!contact) throw new HTTP404Error({ message: 'Contact not found in your account' });
    return this.set(contact, optedOut);
  }

  private async set(contact: ContactIdentity, optedOut: boolean) {
    // Sync duplicates only for this account, business number and full country identity.
    await db('contacts').where({ company_id: contact.company_id, user_id: contact.user_id,
      phone_number_id: contact.phone_number_id, country_code: contact.country_code, phone_number: contact.phone_number })
      .update({ is_opted_out: optedOut, updated_at: new Date() });
    return { id: contact.id, is_opted_out: optedOut };
  }
  async incoming(phone: PhoneContext, contact: ContactIdentity, message: IncomingCommand) {
    const decision = keywordDecision(phone, message);
    if (decision === undefined) return false;
    if (phone.id !== contact.phone_number_id || phone.company_id !== contact.company_id || phone.user_id !== contact.user_id) {
      throw new HTTP400Error({ message: 'Incoming contact does not match the receiving account and number' });
    }
    await this.set(contact, decision);
    return true;
  }
  async isBlocked(phone: PhoneContext, recipient: string): Promise<boolean> {
    if (!phone.id || !phone.company_id || !phone.user_id) throw new HTTP400Error({ message: 'Campaign phone scope is required' });
    const identity = { phone_number: '+' + campaignRecipientNumber(recipient) };
    return Boolean(await db('contacts').where({ company_id: phone.company_id, user_id: phone.user_id,
      phone_number_id: phone.id, phone_number: identity.phone_number, is_opted_out: true })
      .whereNull('deleted_at').first('id'));
  }
  async excluded(companyId: string, userId: string, phoneNumberId: string): Promise<Set<string>> {
    const phone = await this.ownedPhone({ companyId, ownerId: userId, actorId: userId }, phoneNumberId);
    const rows = await db('contacts').where({ company_id: companyId, user_id: userId, phone_number_id: phone.id, is_opted_out: true })
      .whereNull('deleted_at').select('country_code', 'phone_number');
    const numbers = new Set<string>();
    for (const row of rows) {
      try { numbers.add(campaignRecipientNumber(row.phone_number, row.country_code)); } catch { /* Malformed stored identities cannot be compared. */ }
    }
    return numbers;
  }
}
export default new ContactOptOutService();
