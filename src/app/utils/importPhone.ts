import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export function parseImportedPhone(value: unknown, fallbackCode = '') {
  // Remove invisible directional/zero-width formatting copied from messaging apps.
  const raw = String(value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) throw new Error('Invalid phone number characters');
  const cleaned = raw.replace(/[\s().-]/g, '');
  const explicit = cleaned.startsWith('+') || cleaned.startsWith('00');
  const international = parsePhoneNumberFromString(cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned.startsWith('+') ? cleaned : `+${cleaned}`);
  if (explicit) {
    if (!international?.isValid()) throw new Error('Invalid international phone number');
    return { phone_number: international.number, country_code: international.countryCallingCode };
  }
  const code = fallbackCode.replace(/^\+/, '').trim();
  const national = code ? parsePhoneNumberFromString(cleaned, { defaultCallingCode: code }) : undefined;
  const candidates = [international, national].filter(number => number?.isValid());
  const unique = [...new Map(candidates.map(number => [number!.number, number!])).values()];
  if (unique.length !== 1) throw new Error(unique.length ? 'Ambiguous phone number: add + and the country calling code' : 'Invalid phone number: supply an international number or a default country code');
  return { phone_number: unique[0].number, country_code: unique[0].countryCallingCode };
}
