import { parseImportedPhone, parseWhatsAppPhone, parseStoredContactPhone } from './importPhone';

interface SavedPhone { id: string; phone_number: string; country_code?: string | null }

/** Saved contact metadata supplies the country for national numbers; no global default. */
export function resolveCampaignPhone(value: string, contacts: SavedPhone[], options: { countryCode?: string; allowBareInternational?: boolean } = {}) {
  const raw = String(value).trim();
  if (!/^[+\d\s().-]+$/.test(raw)) throw new Error('Invalid recipient phone number');
  const digits = raw.replace(/[^0-9]/g, '');
  const explicit = raw.startsWith('+') || raw.startsWith('00');
  const requested = explicit || options.countryCode ? parseImportedPhone(raw, options.countryCode || '') : undefined;
  const matches = new Map<string, { phone_number: string; country_code: string; contact?: SavedPhone }>();
  for (const contact of contacts) {
    try {
      const parsed = parseImportedPhone(contact.phone_number, String(contact.country_code || ''));
      const national = parsed.phone_number;
      const full = parsed.country_code + national;
      if (requested ? requested.country_code === parsed.country_code && requested.phone_number === parsed.phone_number :
        digits === full || digits === national || digits === `0${national}`) {
        matches.set(full, { ...parsed, contact });
      }
    } catch { /* Malformed legacy contacts cannot supply a reliable country code. */ }
  }
  if (matches.size > 1) throw new Error('Multiple contacts match this local number; include + and the country calling code');
  if (matches.size === 1) return [...matches.values()][0];
  return { ...(requested || (options.allowBareInternational ? parseWhatsAppPhone(raw) : parseImportedPhone(raw))), contact: undefined };
}

/** Validate HTTP inputs before any campaign/contact writes. Country inference remains in the resolver. */
export function validateCampaignPhoneInputs(filters: any, countryCode?: unknown) {
  if (countryCode !== undefined && (typeof countryCode !== 'string' && typeof countryCode !== 'number')) {
    throw new Error('country_code must be a calling code or ISO country code');
  }
  if (countryCode !== undefined && !/^(?:\+?\d{1,3}|00\d{1,3}|[a-zA-Z]{2})$/.test(String(countryCode).trim())) {
    throw new Error('country_code must be a calling code such as 65 or +91, or an ISO code such as SG');
  }
  if (filters?.contactNumber === undefined) return;
  if (!Array.isArray(filters.contactNumber) || !filters.contactNumber.length) {
    throw new Error('contact_filters.contactNumber must be a non-empty array of phone numbers');
  }
  filters.contactNumber.forEach((value: unknown, index: number) => {
    if ((typeof value !== 'string' && typeof value !== 'number') ||
        (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) ||
        !/^[+\d\s().-]+$/.test(String(value).trim()) || !/\d/.test(String(value))) {
      throw new Error(`contact_filters.contactNumber[${index}] must be a phone number string or exact positive integer`);
    }
  });
}

/** Campaigns may attempt unresolved numeric recipients; never invent a calling code. */
export function campaignRecipientNumber(value: string, countryCode?: string | null): string {
  return parseStoredContactPhone(value, countryCode || '').phone_number.replace(/^\+/, '');
}

export function resolveOptionalCampaignPhone(value: string, contacts: SavedPhone[], countryCode?: string) {
  try {
    return resolveCampaignPhone(value, contacts, { countryCode, allowBareInternational: true });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Multiple contacts')) throw error;
    return { ...parseStoredContactPhone(value, countryCode || ''), contact: undefined };
  }
}
