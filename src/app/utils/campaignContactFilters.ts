import { validate as isUUID } from 'uuid';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { normalizeCountryCodes } from './countryCode';
import { CampaignContactSelection } from '../interfaces/campaignContacts.interface';

function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HTTP400Error({ message });
}

function text(value: unknown, key: string): string {
  requireInput(typeof value === 'string' && value.trim().length > 0 && value.length <= 255,
    `${key} must be a non-empty string of at most 255 characters`);
  return value.trim();
}

function ids(value: unknown, key: string): string[] {
  const values = Array.isArray(value) ? value : [value];
  requireInput(values.every(item => typeof item === 'string'), `${key} must contain UUIDs`);
  const result = [...new Set((values as string[]).flatMap(item => item.split(',').map(id => id.trim())))];
  requireInput(result.length > 0 && result.every(isUUID), `${key} must contain UUIDs`);
  return result;
}

/** This endpoint always returns eligible contacts; pagination and opt-out overrides are rejected. */
export function parseCampaignContactQuery(query: Record<string, unknown>): CampaignContactSelection {
  const allowed = ['phone_number_id', 'search', 'country_code', 'tag_ids', 'list_ids', 'status',
    'is_valid', 'is_opted_out', 'attributes', 'sortBy', 'sortOrder'];
  requireInput(Object.keys(query).every(key => allowed.includes(key)), 'Unsupported query parameter; pagination is not supported');
  const phoneNumberId = text(query.phone_number_id, 'phone_number_id');
  requireInput(isUUID(phoneNumberId) || /^\d+$/.test(phoneNumberId), 'phone_number_id must be a sender UUID or Meta phone number ID');
  const result: CampaignContactSelection = { phoneNumberId, filters: {}, sortBy: 'created_at', sortOrder: 'desc' };
  if (query.search !== undefined) {
    requireInput(typeof query.search === 'string' && query.search.length <= 255, 'search must be a string of at most 255 characters');
    if (query.search.trim()) result.filters.search = query.search.trim();
  }
  if (query.country_code !== undefined) {
    const values = Array.isArray(query.country_code) ? query.country_code : [query.country_code];
    requireInput(values.every(value => typeof value === 'string'), 'country_code must contain calling codes');
    try { result.filters.country_code = normalizeCountryCodes((values as string[]).flatMap(value => value.split(','))); }
    catch (error) { throw new HTTP400Error({ message: error instanceof Error ? error.message : 'Invalid country_code' }); }
  }
  for (const key of ['tag_ids', 'list_ids'] as const) {
    if (query[key] !== undefined) result.filters[key] = ids(query[key], key);
  }
  if (query.status !== undefined) {
    const status = text(query.status, 'status');
    requireInput(isUUID(status), 'status must be a contact stage UUID');
    result.filters.status = status;
  }
  if (query.is_valid !== undefined) {
    requireInput(query.is_valid === 'true' || query.is_valid === 'false', 'is_valid must be true or false');
    result.filters.is_valid = query.is_valid === 'true';
  }
  requireInput(query.is_opted_out === undefined || query.is_opted_out === 'false', 'Eligible contacts require is_opted_out=false');
  if (query.attributes !== undefined) {
    requireInput(typeof query.attributes === 'string', 'attributes must be a JSON object');
    let attributes: unknown;
    try { attributes = JSON.parse(query.attributes); }
    catch { throw new HTTP400Error({ message: 'attributes must be valid JSON' }); }
    requireInput(attributes && typeof attributes === 'object' && !Array.isArray(attributes) &&
      Object.entries(attributes).every(([key, value]) => key.length > 0 &&
        ['string', 'number', 'boolean'].includes(typeof value)), 'attributes must contain scalar values in a JSON object');
    result.filters.attributes = attributes as CampaignContactSelection['filters']['attributes'];
  }
  if (query.sortBy !== undefined) {
    requireInput(['created_at', 'updated_at', 'name', 'phone_number'].includes(query.sortBy as string), 'Invalid sortBy');
    result.sortBy = query.sortBy as CampaignContactSelection['sortBy'];
  }
  if (query.sortOrder !== undefined) {
    requireInput(query.sortOrder === 'asc' || query.sortOrder === 'desc', 'sortOrder must be asc or desc');
    result.sortOrder = query.sortOrder;
  }
  return result;
}
