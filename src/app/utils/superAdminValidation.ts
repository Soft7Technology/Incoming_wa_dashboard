import { validate as isUUID } from 'uuid';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { SuperAdminFilters, AccountStatus } from '../interfaces/superAdmin.interface';

export function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HTTP400Error({ message });
}
export function uuid(value: unknown, field: string): string {
  requireInput(typeof value === 'string' && isUUID(value), `${field} must be a UUID`);
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  requireInput(value && typeof value === 'object' && !Array.isArray(value), 'JSON object required');
  return value as Record<string, unknown>;
}
export function allowed(data: Record<string, unknown>, keys: string[]) {
  requireInput(
    Object.keys(data).every((key) => keys.includes(key)),
    'Unsupported field in request',
  );
}
export function text(value: unknown, field: string, max = 255): string {
  requireInput(
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max,
    `${field} must contain 1?${max} characters`,
  );
  return value.trim();
}
export function email(value: unknown): string {
  const result = text(value, 'email').toLowerCase();
  requireInput(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result), 'Invalid email');
  return result;
}
export function status(value: unknown): AccountStatus {
  requireInput(
    ['active', 'inactive', 'suspended'].includes(value as string),
    'status must be active, inactive or suspended',
  );
  return value as AccountStatus;
}
export function filters(raw: Record<string, unknown>): SuperAdminFilters {
  allowed(raw, ['page', 'limit', 'search', 'status', 'company_id', 'user_id', 'domain_status', 'from', 'to']);
  const integer = (value: unknown, fallback: number, maximum: number) => {
    if (value === undefined) return fallback;
    requireInput(typeof value === 'string' && /^[1-9]\d*$/.test(value), 'Pagination must contain positive integers');
    const result = Number(value);
    requireInput(Number.isSafeInteger(result) && result <= maximum, `Pagination exceeds ${maximum}`);
    return result;
  };
  const result: SuperAdminFilters = { page: integer(raw.page, 1, 1000000), limit: integer(raw.limit, 25, 100) };
  for (const key of ['search', 'status', 'domain_status'] as const)
    if (raw[key] !== undefined) result[key] = text(raw[key], key, 200);
  for (const key of ['company_id', 'user_id'] as const) if (raw[key] !== undefined) result[key] = uuid(raw[key], key);
  for (const key of ['from', 'to'] as const)
    if (raw[key] !== undefined) {
      const value = text(raw[key], key, 40);
      requireInput(
        /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) && Number.isFinite(Date.parse(value)),
        `${key} must be an ISO date or UTC timestamp`,
      );
      result[key] = new Date(value).toISOString();
    }
  requireInput(!result.from || !result.to || result.from < result.to, 'from must precede to (exclusive)');
  return result;
}
export function creditAmount(value: unknown): string {
  const amount = typeof value === 'number' ? String(value) : value;
  requireInput(
    typeof amount === 'string' && /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(amount) && Number(amount) > 0,
    'amount must be positive with at most 13 integer digits and 2 decimal places',
  );
  return Number(amount).toFixed(2);
}
