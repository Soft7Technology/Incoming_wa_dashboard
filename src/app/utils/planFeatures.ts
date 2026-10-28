import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export type ResetPeriod = 'never' | 'monthly' | 'yearly';
export interface FeatureLimit {
  limit_type: string;
  limit_value: number | null;
  enabled?: boolean;
  reset_period?: ResetPeriod;
}

export interface PlanAddonSelection { addon_id: string; enabled: boolean }

/** SQL/JSON null is reserved for historical unrestricted catalogs; API omission uses []. */
export function snapshotPlanAddons(input: unknown): PlanAddonSelection[] | null {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new HTTP400Error({ message: 'Invalid saved plan add-ons' }); }
  }
  if (input == null) return null;
  if (!Array.isArray(input) || input.length > 100) throw new HTTP400Error({ message: 'addons must be an array of at most 100 selections' });
  const seen = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['addon_id', 'enabled'].includes(key)) ||
        typeof value.addon_id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.addon_id) ||
        typeof value.enabled !== 'boolean' || seen.has(value.addon_id.toLowerCase())) throw new HTTP400Error({
      message: 'Each add-on needs a unique addon_id UUID and boolean enabled; prices and units come from the superadmin catalog',
    });
    seen.add(value.addon_id.toLowerCase());
    return { addon_id: value.addon_id.toLowerCase(), enabled: value.enabled };
  });
}

// Keep the keys already used by resource services; labels can change independently.
export const FEATURE_ALIASES: Record<string, string> = {
  contacts: 'Contact',
  campaigns: 'Campaign',
  chatbot: 'Chatbot',
  chatbots: 'Chatbot',
  team_invites: 'TeamInvite',
  team_members: 'TeamInvite',
  ai_assistant: 'AiAssistant',
  ai_assistants: 'AiAssistant',
  waba_number: 'WabaNumber',
  waba_numbers: 'WabaNumber',
  TeamMembers: 'TeamInvite',
  WABANumber: 'WabaNumber',
  AIAssistant: 'AiAssistant',
};
export const featureKey = (key: string) =>
  Object.prototype.hasOwnProperty.call(FEATURE_ALIASES, key) ? FEATURE_ALIASES[key] : key;

/** Historical JSON snapshots may contain decimal integer strings; never coerce booleans or fractions. */
export function storedAddonLimit(value: unknown): number {
  const parsed = value == null ? 0 : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : NaN;
}

/** These resources are available independently of subscription entitlements. */
export function isUnmeteredFeature(key: string): boolean {
  return ['tag', 'tags', 'message', 'messages', 'column', 'columns',
    'customcolumn', 'customcolumns', 'contactcolumn', 'contactcolumns',
    'createcolumn', 'createcolumns'].includes(key.replace(/[_\s-]/g, '').toLowerCase());
}

export function normalizeFeatures(input: unknown): Record<string, FeatureLimit> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HTTP400Error({ message: 'features must be an object' });
  }
  const result: Record<string, FeatureLimit> = Object.create(null);
  for (const [rawKey, raw] of Object.entries(input)) {
    // Ignore historical client fields; never persist quotas for these resources.
    if (isUnmeteredFeature(rawKey)) continue;
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
