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
