import { validate as isUUID } from 'uuid';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import ApiRequestLogModel, { ApiLogFilters } from '../models/apiRequestLog.model';

function bad(message: string): never { throw new HTTP400Error({ message }); }
export function apiLogFilters(query: Record<string, any>, includeStatus = false): ApiLogFilters {
  const string = (key: string) => {
    if (query[key] === undefined) return undefined;
    if (typeof query[key] !== 'string' || !query[key].trim()) bad(`Invalid ${key}`);
    return query[key].trim() as string;
  };
  const integer = (key: string, fallback: number, max: number, min = 1) => {
    const raw = string(key);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) bad(`Invalid ${key}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) bad(`${key} must be between ${min} and ${max}`);
    return value;
  };
  const filter: ApiLogFilters = { page: integer('page', 1, 1000000), limit: integer('limit', 20, 100) };
  for (const key of ['api_key_id', 'request_id'] as const) {
    const value = string(key);
    if (value && !isUUID(value)) bad(`Invalid ${key}`);
    filter[key] = value;
  }
  const outcome = string('outcome');
  if (outcome && !['success', 'failed', 'pending', 'aborted'].includes(outcome)) bad('Invalid outcome');
  filter.outcome = outcome;
  if (query.http_status !== undefined) filter.http_status = integer('http_status', 200, 599, 100);
  filter.method = string('method')?.toUpperCase();
  if (filter.method && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(filter.method)) bad('Invalid method');
  filter.endpoint = string('endpoint');
  if (filter.endpoint && (filter.endpoint.length > 2048 || !filter.endpoint.startsWith('/v1/api/') || /[?#]/.test(filter.endpoint))) bad('endpoint must be an API path without query parameters');
  for (const key of ['from_date', 'to_date'] as const) {
    const value = string(key);
    if (value) {
      // Explicit offsets avoid browser/server timezone disagreements.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) bad(`${key} must be an ISO timestamp with timezone`);
      filter[key] = new Date(value);
    }
  }
  if (filter.from_date && filter.to_date && filter.from_date > filter.to_date) bad('from_date must not be after to_date');
  const status = string('status');
  if (status && (!includeStatus || !['queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'unknown', 'deleted'].includes(status))) bad('Invalid message status filter');
  if (includeStatus) filter.status = status;
  return filter;
}

class ApiRequestLogService {
  private scope(account: { userId?: string; companyId?: string }) {
    if (!account.userId || !account.companyId) throw new HTTP403Error({ message: 'User and company context are required' });
    // API keys are personal; team membership never grants access to another user's payloads.
    return { userId: account.userId, companyId: account.companyId };
  }
  list(account: any, query: any, messages = false) {
    return ApiRequestLogModel.list(this.scope(account), apiLogFilters(query, messages), messages);
  }
  summary(account: any, query: any) {
    return ApiRequestLogModel.summary(this.scope(account), apiLogFilters(query));
  }
  async detail(account: any, id: string) {
    const scope = this.scope(account);
    if (!isUUID(id)) bad('Invalid request ID');
    const log = await ApiRequestLogModel.detail(scope, id);
    if (!log) throw new HTTP404Error({ message: 'API request not found' });
    return log;
  }
}
export default new ApiRequestLogService();
