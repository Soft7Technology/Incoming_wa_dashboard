import { parsePhoneNumberFromString, isSupportedCountry, getCountryCallingCode, CountryCode } from 'libphonenumber-js/max';

/** Expand scientific notation using decimal digits, without floating-point rounding. */
function expandScientificPhone(raw: string): string {
  const match = raw.match(/^(\+?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) return raw;
  const [, prefix, whole, fraction = '', exponentText] = match;
  const exponent = Number(exponentText);
  // Bound expansion before allocating strings from untrusted spreadsheet content.
  if (raw.length > 256 || !Number.isSafeInteger(exponent) || Math.abs(exponent) > 256) {
    throw new Error('Scientific notation phone number is too large');
  }
  const digits = whole + fraction;
  const decimalPosition = whole.length + exponent;
  if (decimalPosition <= 0 || (decimalPosition < digits.length && /[1-9]/.test(digits.slice(decimalPosition)))) {
    throw new Error('Phone number must be a whole number');
  }
  const expanded = (decimalPosition < digits.length
    ? digits.slice(0, decimalPosition)
    : digits + '0'.repeat(decimalPosition - digits.length)).replace(/^0+/, '');
  if (!expanded || expanded.length > 15) throw new Error('Phone number must contain at most 15 digits');
  return prefix + expanded;
}

export function parseImportedPhone(value: unknown, fallbackCode = '', rowCountryCode = false, _requireCountryContext = true) {
  // Remove invisible directional/zero-width formatting copied from messaging apps.
  // Numeric Excel cells must already contain an exact integer; lost digits cannot be recovered.
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0 || value >= 1e15)) {
    throw new Error('Excel phone number must be a positive exact integer with at most 15 digits');
  }
  const raw = expandScientificPhone(String(value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim());
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) throw new Error('Invalid phone number characters');
  const cleaned = raw.replace(/[\s().-]/g, '');
  const explicit = cleaned.startsWith('+') || cleaned.startsWith('00');
  const international = parsePhoneNumberFromString(cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned.startsWith('+') ? cleaned : `+${cleaned}`);
  const hint = String(fallbackCode ?? '').trim().toUpperCase();
  const code = isSupportedCountry(hint)
    ? getCountryCallingCode(hint as CountryCode)
    : hint.replace(/^(?:\+|00)/, '');
  if (hint && !/^[1-9]\d{0,2}$/.test(code)) {
    throw new Error('Country code must be a calling code such as +65 or an ISO code such as SG');
  }
  if (explicit) {
    if (!international?.isValid()) throw new Error('Invalid international phone number');
    if (rowCountryCode && code && international.countryCallingCode !== code) {
      throw new Error('International phone number conflicts with the row country code');
    }
    return { phone_number: international.nationalNumber, country_code: international.countryCallingCode };
  }
  const national = code ? parsePhoneNumberFromString(cleaned, { defaultCallingCode: code }) : undefined;
  // Bare digits are not evidence of a country: an Indian mobile beginning 95
  // must not become a Myanmar number when India was selected for the import.
  if (code) {
    const full = international?.isValid() && international.countryCallingCode === code ? international : undefined;
    if (full && national?.isValid() && full.number !== national.number) {
      throw new Error('Ambiguous phone number: use + and the country calling code');
    }
    const preferred = full || (national?.isValid() ? national : undefined);
    if (preferred) return { phone_number: preferred.nationalNumber, country_code: preferred.countryCallingCode };
    throw new Error('Phone number does not match the row country code; use + for an international number');
  }
  throw new Error('Country code is required for an unprefixed phone number: add a country_code column, select an import country, or use +countrycode');
}

/** WhatsApp sender IDs and API recipients explicitly carry an international calling code. */
export function parseWhatsAppPhone(value: unknown) {
  const raw = String(value ?? '').trim();
  return parseImportedPhone(raw.startsWith('+') || raw.startsWith('00') ? raw : `+${raw}`);
}

/** Stored fields are national digits + calling code. Never infer a missing country. */
export function buildRecipient(phone: unknown, countryCode?: unknown): string {
  const raw = String(phone ?? '').trim();
  const hint = String(countryCode ?? '').trim().toUpperCase();
  const code = isSupportedCountry(hint)
    ? getCountryCallingCode(hint as CountryCode) : hint.replace(/^(?:\+|00)/, '');
  // Explicit legacy international values remain readable until migration.
  if (raw.startsWith('+') || raw.startsWith('00')) {
    const parsed = parseImportedPhone(raw, code, Boolean(code));
    return parsed.country_code + parsed.phone_number;
  }
  if (!code) throw new Error('Country code is required to construct an international recipient');
  if (!/^[1-9]\d{0,2}$/.test(code) || !/^\d+$/.test(raw)) {
    throw new Error('Recipient requires national digits and a valid country calling code');
  }
  const parsed = parseWhatsAppPhone(code + raw);
  if (parsed.country_code !== code || parsed.phone_number !== raw) {
    throw new Error('Recipient phone number is not a valid national number for its country code');
  }
  return code + raw;
}

/** Canonical contact storage. country_code is derived metadata, not part of the phone string twice. */
export function toContactPhone(identity: { phone_number: string; country_code: string }) {
  return { phone_number: `+${identity.country_code}${identity.phone_number}`, country_code: identity.country_code };
}

export class NeedsCountryError extends Error {
  readonly code = 'NEEDS_COUNTRY';
  constructor() { super('Needs country: select an import country or provide a country_code column'); }
}

/** Validate full international numbers with library metadata; never assume a default country. */
export function parseSpreadsheetPhone(value: unknown, optionalCode = '') {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0 || value >= 1e15)) {
    throw new Error('Excel phone number must be a positive exact integer with at most 15 digits');
  }
  const raw = expandScientificPhone(String(value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim());
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) throw new Error('Invalid phone number characters');
  const cleaned = raw.replace(/[\s().-]/g, '');
  if (!/^(?:[+]|00)?[0-9]+$/.test(cleaned)) throw new Error('Invalid phone number format');
  if (cleaned.startsWith('+') || cleaned.startsWith('00')) return parseImportedPhone(cleaned);
  if (cleaned.length > 15 || cleaned.length < 4) throw new Error('Invalid phone number length');

  // With reliable country context, resolve local numbers within that country first.
  // An explicit international number from another country remains acceptable.
  if (optionalCode) {
    try { return parseImportedPhone(cleaned, optionalCode); }
    catch (error) {
      const international = parsePhoneNumberFromString(`+${cleaned}`);
      if (international?.isValid()) return { phone_number: international.nationalNumber, country_code: international.countryCallingCode };
      throw error;
    }
  }
  const international = parsePhoneNumberFromString(`+${cleaned}`);
  if (international?.isValid()) return { phone_number: international.nationalNumber, country_code: international.countryCallingCode };
  throw new NeedsCountryError();
}

/** Importable is different from sendable: preserve numeric contacts without guessing a country. */
export function parseStoredContactPhone(value: unknown, optionalCode = '') {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0 || value >= 1e15)) {
    throw new Error('Excel phone number must be an exact positive integer with at most 15 digits');
  }
  const raw = expandScientificPhone(String(value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim());
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) throw new Error('Invalid phone number characters');
  const cleaned = raw.replace(/[\s().-]/g, '');
  if (!/^[+]?[0-9]+$/.test(cleaned)) throw new Error('Invalid phone number format');
  const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned.startsWith('00') ? cleaned.slice(2) : cleaned;
  if (digits.length < 4 || digits.length > 15) throw new Error('Phone number must contain 4 to 15 digits');
  try {
    const identity = parseSpreadsheetPhone(raw, optionalCode);
    return { ...toContactPhone(identity), is_valid: true };
  } catch {
    // Missing country context does not prevent saving. No calling code is invented.
    return { phone_number: `+${digits}`, country_code: null, is_valid: false };
  }
}

/** An explicitly selected country on an edit replaces the saved calling code. */
export function parseContactPhoneUpdate(value: unknown, countryCode: unknown,
  previous: { phone_number: string; country_code?: string | null }) {
  if (countryCode === undefined || countryCode === null || countryCode === '') {
    return parseStoredContactPhone(value, previous.country_code || '');
  }
  if (typeof countryCode !== 'string') throw new Error('Country code must be a calling code or an ISO country code');
  const hint = countryCode.trim().toUpperCase();
  const code = isSupportedCountry(hint) ? getCountryCallingCode(hint as CountryCode) : hint.replace(/^(?:\+|00)/, '');
  if (!/^[1-9]\d{0,2}$/.test(code) || parsePhoneNumberFromString(`+${code}1234567890`)?.countryCallingCode !== code) {
    throw new Error('Country code must be a valid calling code or an ISO country code');
  }

  // Reuse storage validation for characters, scientific notation and digit bounds.
  const input = parseStoredContactPhone(value);
  let national = input.phone_number.slice(1);
  const oldCode = String(previous.country_code || '').replace(/^\+/, '');
  const oldDigits = previous.phone_number.replace(/[^0-9]/g, '').replace(/^00/, '');
  const previousIsInternational = /^\s*(?:\+|00)/.test(previous.phone_number);
  if (national === oldDigits && previousIsInternational && oldCode && national.startsWith(oldCode)) {
    national = national.slice(oldCode.length);
  } else if (input.country_code === code ||
      (/^\s*(?:\+|00)/.test(String(value)) && national.startsWith(code))) {
    national = national.slice(code.length);
  } else if (input.is_valid && /^\s*(?:\+|00)/.test(String(value))) {
    national = national.slice(input.country_code!.length);
  }

  // An unresolved number's leading '+' does not establish a country prefix.
  // Keep its digits and add the selected code, even if it remains unsendable.
  const local = parsePhoneNumberFromString(national, { defaultCallingCode: code });
  if (local?.isValid() && local.countryCallingCode === code) national = local.nationalNumber;
  const phoneNumber = `+${code}${national}`;
  if (!/^[+][0-9]{4,15}$/.test(phoneNumber)) throw new Error('Phone number must contain 4 to 15 digits');
  const parsed = parsePhoneNumberFromString(phoneNumber);
  return { phone_number: phoneNumber, country_code: code,
    is_valid: Boolean(parsed?.isValid() && parsed.countryCallingCode === code) };
}
