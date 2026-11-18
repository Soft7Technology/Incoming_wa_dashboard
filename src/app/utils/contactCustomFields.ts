import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export function parseContactCustomFields(value: unknown, fieldName: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new HTTP400Error({ message: `${fieldName} must be valid JSON` });
    }
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new HTTP400Error({ message: `${fieldName} must be a JSON object` });
  }

  return parsed as Record<string, unknown>;
}

/** Keep display spelling, but treat capitalization/outer whitespace as the same key. */
export function contactFieldKey(key: string): string {
  return key.trim().toLowerCase();
}

export function synchronizedContactFields(input: any, stored: any = {}): Record<string, any> {
  if (input.attributes === undefined && input.custom_fields === undefined) return {};
  const result: Record<string, unknown> = {};
  const keys = new Map<string, string>();
  const incoming = new Map<string, unknown>();
  const merge = (source: unknown, label: string, validate: boolean) => {
    for (const [rawKey, value] of Object.entries(parseContactCustomFields(source, label) || {})) {
      const key = contactFieldKey(rawKey);
      if (!key) throw new HTTP400Error({ message: 'Contact attribute names cannot be empty' });
      if (validate && incoming.has(key) && JSON.stringify(incoming.get(key)) !== JSON.stringify(value)) {
        throw new HTTP400Error({ message: `Conflicting values for contact attribute "${rawKey.trim()}". Submit one value in attributes or custom_fields.` });
      }
      if (validate) incoming.set(key, value);
      const spelling = keys.get(key) ?? rawKey.trim();
      keys.set(key, spelling);
      Object.defineProperty(result, spelling, { value, enumerable: true, configurable: true });
    }
  };
  // Existing edits take precedence over legacy imports; new input takes precedence over both.
  merge(stored.attributes ?? {}, 'stored attributes', false);
  merge(stored.custom_fields ?? {}, 'stored custom_fields', false);
  merge(input.attributes, 'attributes', true);
  merge(input.custom_fields, 'custom_fields', true);
  return { attributes: result, custom_fields: { ...result } };
}

/** Exact keys remain compatible; otherwise only an unambiguous case-insensitive match is allowed. */
export function findContactFieldKey(source: any, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(source, key)) return key;
  const matches = Object.keys(source).filter(candidate => contactFieldKey(candidate) === contactFieldKey(key));
  if (matches.length > 1 && matches.some(candidate => JSON.stringify(source[candidate]) !== JSON.stringify(source[matches[0]]))) {
    throw new HTTP400Error({ message: `Ambiguous contact attribute "${key}". Remove conflicting duplicate attributes.` });
  }
  return matches[0];
}
