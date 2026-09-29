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
