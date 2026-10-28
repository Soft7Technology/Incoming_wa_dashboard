import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export type ResetPeriod = 'never' | 'monthly' | 'yearly';
export interface FeatureLimit {
  limit_type: string;
  limit_value: number | null;
  enabled?: boolean;
  reset_period?: ResetPeriod;
}

// Keep the keys already used by resource services; labels can change independently.
export const FEATURE_ALIASES: Record<string, string> = {
  TeamMembers: 'TeamInvite',
  WABANumber: 'WabaNumber',
  AIAssistant: 'AiAssistant',
};
export const featureKey = (key: string) =>
  Object.prototype.hasOwnProperty.call(FEATURE_ALIASES, key) ? FEATURE_ALIASES[key] : key;

export function normalizeFeatures(input: unknown): Record<string, FeatureLimit> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HTTP400Error({ message: 'features must be an object' });
  }
  const result: Record<string, FeatureLimit> = Object.create(null);
  for (const [rawKey, raw] of Object.entries(input)) {
    const key = featureKey(rawKey);
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
      ['constructor', 'prototype', '__proto__'].includes(key) ||
      result[key]
    ) {
      throw new HTTP400Error({ message: `Invalid or duplicate feature key: ${rawKey}` });
    }
    const value = raw as FeatureLimit;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
      (value.limit_value !== null && (!Number.isSafeInteger(value.limit_value) || value.limit_value < 0)) ||
      (value.reset_period !== undefined && !['never', 'monthly', 'yearly'].includes(value.reset_period))
    ) {
      throw new HTTP400Error({
        message: `Invalid ${key}: use a non-negative integer or null for unlimited, and reset_period never/monthly/yearly`,
      });
    }
    result[key] = {
      limit_type: key,
      limit_value: value.enabled === false ? 0 : value.limit_value,
      enabled: value.enabled ?? true,
      reset_period: value.reset_period ?? 'never',
    };
  }
  return result;
}

export function snapshotFeatures(input: unknown) {
  const features = normalizeFeatures(typeof input === 'string' ? JSON.parse(input) : input);
  const limits: Record<string, any> = {},
    usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(features)) {
    limits[key] = { limit: value.limit_value, enabled: value.enabled, reset_period: value.reset_period };
    usage[key] = 0;
  }
  return { limits, usage };
}

// Anniversary periods are anchored to plan start in UTC, including month-end clamping.
export function usagePeriodStart(start: Date, now: Date, period: ResetPeriod): string {
  if (period === 'never') return start.toISOString();
  const step = period === 'yearly' ? 12 : 1;
  const elapsed = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  let months = Math.floor(elapsed / step) * step;
  const at = (offset: number) => {
    const date = new Date(start);
    date.setUTCDate(1);
    date.setUTCMonth(start.getUTCMonth() + offset);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(start.getUTCDate(), last));
    return date;
  };
  if (at(months) > now) months -= step;
  return at(Math.max(0, months)).toISOString();
}
