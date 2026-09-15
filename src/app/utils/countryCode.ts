export function normalizeCountryCodes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) throw new Error('country_code must contain at least one calling code');
  return [...new Set(values.map(code => {
    // Query parsers decode an unescaped + as a space.
    if (typeof code !== 'string' || !/^\+?[1-9]\d{0,2}$/.test(code.trim())) {
      throw new Error('country_code must be a 1 to 3 digit calling code, optionally prefixed with +');
    }
    return code.trim().replace(/^\+/, '');
  }))];
}

export function countryCodeFilterValues(value: unknown): string[] {
  return normalizeCountryCodes(value).flatMap(code => [code, `+${code}`]);
}
