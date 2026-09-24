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

export function parseImportedPhone(value: unknown, fallbackCode = '', rowCountryCode = false, requireCountryContext = false) {
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
  if (explicit) {
    if (!international?.isValid()) throw new Error('Invalid international phone number');
    return { phone_number: international.number, country_code: international.countryCallingCode };
  }
  const hint = String(fallbackCode ?? '').trim().toUpperCase();
  const code = isSupportedCountry(hint)
    ? getCountryCallingCode(hint as CountryCode)
    : hint.replace(/^(?:\+|00)/, '');
  if (hint && !/^\d{1,3}$/.test(code)) {
    throw new Error('Country code must be a calling code such as +65 or an ISO code such as SG');
  }
  const national = code ? parsePhoneNumberFromString(cleaned, { defaultCallingCode: code }) : undefined;
  // Bare digits are not evidence of a country: an Indian mobile beginning 95
  // must not become a Myanmar number when India was selected for the import.
  if (code) {
    const preferred = international?.isValid() && international.countryCallingCode === code
      ? international : national?.isValid() ? national : undefined;
    if (preferred) return { phone_number: preferred.number, country_code: preferred.countryCallingCode };
    if (rowCountryCode) throw new Error('Phone number does not match the row country code; use + for an international number');
  }
  if (!code && requireCountryContext) {
    throw new Error('Country code is required for an unprefixed phone number: add a country_code column, select an import country, or use +countrycode');
  }
  const candidates = [international, national].filter(number => number?.isValid());
  const unique = [...new Map(candidates.map(number => [number!.number, number!])).values()];
  if (unique.length !== 1) throw new Error(unique.length ? 'Ambiguous phone number: add + and the country calling code' : 'Invalid phone number: supply an international number or a default country code');
  return { phone_number: unique[0].number, country_code: unique[0].countryCallingCode };
}
