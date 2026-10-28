import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export const supportStatuses = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type SupportStatus = typeof supportStatuses[number];
export interface SupportScope { userId?: string; companyId?: string }

export function supportObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTP400Error({ message: 'A JSON object is required' });
  }
  return value as Record<string, any>;
}

export function supportText(value: unknown, field: string, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HTTP400Error({ message: `${field} must contain 1–${max} characters` });
  }
  return value.trim();
}

export function supportUuid(value: unknown, field = 'ticketId'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HTTP400Error({ message: `${field} must be a UUID` });
  }
  return value.toLowerCase();
}

// PostgreSQL bigint IDs must stay strings throughout replay and pagination.
export function supportCursor(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
      (value.length === 19 && value > '9223372036854775807')) {
    throw new HTTP400Error({ message: 'Cursor must be a non-negative bigint string' });
  }
  return value;
}

export function supportLimit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || Number(value) > 100) {
    throw new HTTP400Error({ message: 'limit must be between 1 and 100' });
  }
  return Number(value);
}

export function supportStatus(value: unknown): SupportStatus {
  if (!supportStatuses.includes(value as SupportStatus)) {
    throw new HTTP400Error({ message: `status must be ${supportStatuses.join(', ')}` });
  }
  return value as SupportStatus;
}
