import { parseImportedPhone } from './importPhone';

interface SavedPhone { id: string; phone_number: string; country_code?: string | null }

/** Saved contact metadata supplies the country for national numbers; no global default. */
export function resolveCampaignPhone(value: string, contacts: SavedPhone[]) {
  const raw = String(value).trim();
  if (!/^[+\d\s().-]+$/.test(raw)) throw new Error('Invalid recipient phone number');
  const digits = raw.replace(/[^0-9]/g, '');
  const explicit = raw.startsWith('+') || raw.startsWith('00');
  const requested = explicit ? parseImportedPhone(raw) : undefined;
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
  return { ...(requested || parseImportedPhone(raw)), contact: undefined };
}
