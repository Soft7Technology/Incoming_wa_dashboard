import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import {
  ActivityQuery,
  ActivityFilters,
  ActivityPagination,
  ACTIVITY_SORT_COLUMNS,
} from '../interfaces/activity.interface';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseOptionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HTTP400Error({ message: `${name} must be a string` });
  const normalized = value.trim();
  return normalized && (name === 'search' || normalized.toLowerCase() !== 'all') ? normalized : undefined;
}
function parseIdentifier(value: unknown, name: string) {
  const result = parseOptionalText(value, name);
  if (result && !UUID_PATTERN.test(result)) throw new HTTP400Error({ message: `${name} must be a UUID` });
  return result;
}
function parsePositiveInteger(value: unknown, fallback: number, name: string) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw new HTTP400Error({ message: `Invalid ${name}` });
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new HTTP400Error({ message: `${name} must be a positive integer` });
  return number;
}
function parseDateBoundary(value: unknown, name: string, inclusiveEnd = false) {
  const input = parseOptionalText(value, name);
  if (!input) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(input)) throw new HTTP400Error({ message: `Invalid ${name}` });
  const result = new Date(input);
  if (!Number.isFinite(result.getTime()) || (input.length === 10 && result.toISOString().slice(0, 10) !== input)) {
    throw new HTTP400Error({ message: `Invalid ${name}` });
  }
  if (inclusiveEnd && input.length === 10) result.setUTCDate(result.getUTCDate() + 1);
  return result;
}

/** Validate once before building SQL. Filters may narrow, never define, access scope. */
export function parseActivityFilters(filters: ActivityQuery): ActivityFilters {
  const search = parseOptionalText(filters.search, 'search');
  if (search && search.length > 200) {
    throw new HTTP400Error({ message: 'search must not exceed 200 characters' });
  }
  let read: boolean | undefined;
  if (filters.read !== undefined && filters.read !== '' && filters.read !== 'all') {
    if (filters.read !== true && filters.read !== false && filters.read !== 'true' && filters.read !== 'false') {
      throw new HTTP400Error({ message: 'read must be true or false' });
    }
    read = filters.read === true || filters.read === 'true';
  }
  // A date-only upper bound includes the whole UTC day; timestamps remain exclusive.
  const from = parseDateBoundary(filters.date_from ?? filters.start_date, 'date_from');
  const to = parseDateBoundary(filters.date_to ?? filters.end_date, 'date_to', true);
  if (from && to && from >= to) throw new HTTP400Error({ message: 'date_from must be before date_to' });
  const frame = parseOptionalText(filters.time_frame, 'time_frame')?.toLowerCase();
  const supportedFrames = ['today', 'yesterday', '7days', '30days', '90days'] as const;
  const timeFrame = supportedFrames.find((value) => value === frame);
  if (frame && !timeFrame) {
    throw new HTTP400Error({ message: 'Unsupported time_frame' });
  }
  return {
    type: parseOptionalText(filters.type ?? filters.entity_type, 'type'),
    action: parseOptionalText(filters.action, 'action'),
    status: parseOptionalText(filters.status, 'status'),
    userId: parseIdentifier(filters.user_id, 'user_id'),
    companyId: parseIdentifier(filters.company_id, 'company_id'),
    entityId: parseIdentifier(filters.entity_id, 'entity_id'),
    read,
    search,
    from,
    to,
    timeFrame,
  };
}

export function parseActivityPagination(filters: ActivityQuery): ActivityPagination {
  const page = parsePositiveInteger(filters.page, 1, 'page');
  const limit = Math.min(parsePositiveInteger(filters.limit, 10, 'limit'), 100);
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset)) throw new HTTP400Error({ message: 'page is too large' });
  const requestedColumn = parseOptionalText(filters.sorted_by ?? filters.sort_by, 'sorted_by');
  // Only a server-owned column name is allowed into ORDER BY.
  const column = ACTIVITY_SORT_COLUMNS.find((value) => value === requestedColumn) ?? 'created_at';
  const direction = parseOptionalText(filters.sort_order, 'sort_order')?.toLowerCase() === 'asc' ? 'asc' : 'desc';
  return { page, limit, offset, column, direction };
}

export function parseNotificationIds(data: unknown): string[] {
  if (!Array.isArray(data) || data.length === 0 || data.length > 100) {
    throw new HTTP400Error({ message: 'data must contain 1 to 100 notification IDs' });
  }
  return [
    ...new Set(
      data.map((item: unknown) => {
        const value =
          typeof item === 'string' ? item : item && typeof item === 'object' && 'id' in item ? item.id : undefined;
        const id = parseIdentifier(value, 'notification id');
        if (!id) throw new HTTP400Error({ message: 'Notification ID is required' });
        return id;
      }),
    ),
  ];
}
