// Frozen policy for the 20261019000005 data migration. Do not change on future plan-price/limit edits.
export const requiredPlanFeatures = ['TeamInvite', 'Contact', 'Campaign', 'WabaNumber', 'Chatbot', 'AiAssistant'];
const aliases: Record<string, string> = {
  contacts: 'Contact', campaigns: 'Campaign', chatbot: 'Chatbot', chatbots: 'Chatbot',
  team_invites: 'TeamInvite', team_members: 'TeamInvite', TeamMembers: 'TeamInvite',
  ai_assistant: 'AiAssistant', ai_assistants: 'AiAssistant', AIAssistant: 'AiAssistant',
  waba_number: 'WabaNumber', waba_numbers: 'WabaNumber', WABANumber: 'WabaNumber',
};
const capacityKeys = new Set(['TeamInvite', 'Contact', 'WabaNumber', 'Chatbot', 'AiAssistant']);
const paidDefaults: Record<string, number | null> = {
  TeamInvite: 2, Contact: null, Campaign: null, WabaNumber: 3, Chatbot: 10, AiAssistant: null,
};
const trialDefaults: Record<string, number> = {
  TeamInvite: 2, Contact: 500, Campaign: 2, WabaNumber: 1, Chatbot: 2, AiAssistant: 1,
};
export interface FeatureDefinition { key: string; kind: string }
export interface BackfillUsage { capacity: Record<string, number>; campaigns: number }

export function jsonObject(value: any, field: string): Record<string, any> {
  if (typeof value === 'string') value = JSON.parse(value);
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be a JSON object`);
  return value;
}
function keyOf(key: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) {
    throw new Error(`Invalid legacy feature key: ${key}`);
  }
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
}
function limitValue(value: any, field: string): number | null {
  if (value == null || value === -1 || (typeof value === 'string' && /^(unlimited|-1)$/i.test(value.trim()))) return null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid legacy limit: ${field}`);
  return value;
}
function usageValue(value: any, field: string) {
  if (value === undefined || value === null) return 0;
  const count = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid legacy usage: ${field}`);
  return count;
}
function canonicalEntries(input: any, field: string) {
  const raw = jsonObject(input, field), result: Record<string, any> = {};
  // Canonical definitions win conflicts, regardless of JSON property order.
  for (const [key, value] of Object.entries(raw)) if (keyOf(key) !== key && !Object.prototype.hasOwnProperty.call(result, keyOf(key))) result[keyOf(key)] = value;
  for (const [key, value] of Object.entries(raw)) if (keyOf(key) === key) result[key] = value;
  return result;
}
function defaultPeriod(key: string, cycle: string, definitions: FeatureDefinition[]) {
  if (capacityKeys.has(key) || definitions.find(row => row.key === key)?.kind !== 'usage') return 'never';
  return cycle === 'Monthly' ? 'monthly' : cycle === 'Yearly' ? 'yearly' : 'never';
}
function normalizeConfigs(input: any, cycle: string, mode: 'features' | 'limits', definitions: FeatureDefinition[]) {
  const result = canonicalEntries(input, mode);
  for (const [key, value] of Object.entries(result)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid legacy ${mode}.${key}`);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error(`Invalid legacy enabled flag: ${key}`);
    const limitField = mode === 'features' ? 'limit_value' : 'limit';
    const limit = value.enabled === false ? 0 : limitValue(value[limitField], key);
    const period = defaultPeriod(key, cycle, definitions);
    const reset = period === 'never' ? 'never' : value.reset_period ?? period;
    if (!['never', 'monthly', 'yearly'].includes(reset)) throw new Error(`Invalid legacy reset period: ${key}`);
    result[key] = { ...value, [limitField]: limit, enabled: value.enabled ?? true, reset_period: reset,
      ...(mode === 'features' ? { limit_type: key } : {}) };
    if (value.addon_limit !== undefined) result[key].addon_limit = usageValue(value.addon_limit, `${key}.addon_limit`);
  }
  return result;
}

export function backfillSubscription(plan: any, definitions: FeatureDefinition[]) {
  const free = plan.billing_cycle === 'Free';
  const features: Record<string, any> = free ? {} : normalizeConfigs(plan.features, plan.billing_cycle, 'features', definitions);
  // Free catalog limits are platform policy. Existing user snapshots are handled independently below.
  for (const key of requiredPlanFeatures) if (!Object.prototype.hasOwnProperty.call(features, key)) {
    features[key] = { limit_type: key, limit_value: free ? trialDefaults[key] : paidDefaults[key],
      enabled: true, reset_period: defaultPeriod(key, plan.billing_cycle, definitions) };
  }
  const original = jsonObject(plan.features, 'features');
  const legacy = requiredPlanFeatures.some(key => !Object.prototype.hasOwnProperty.call(original, key)) ||
    Object.entries(original).some(([key, value]) => keyOf(key) !== key ||
    value?.enabled === undefined || value?.reset_period === undefined);
  if (!free && legacy) for (const definition of definitions) if (!features[definition.key]) {
    features[definition.key] = { limit_type: definition.key, limit_value: null, enabled: true,
      reset_period: defaultPeriod(definition.key, plan.billing_cycle, definitions) };
  }
  const updates: Record<string, any> = { features };
  if (free) {
    if (plan.trial_days != null && ![3, 7, 10].includes(plan.trial_days)) throw new Error(`Unsupported trial_days for plan ${plan.id}`);
    updates.trial_days = plan.trial_days ?? 10;
  }
  return updates;
}

// Same UTC anniversary behavior as runtime usagePeriodStart, frozen with this migration.
export function backfillPeriodStart(start: Date, now: Date, period: string) {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(now.getTime())) throw new Error('Invalid plan period dates');
  if (period === 'never' || now < start) return start.toISOString();
  const step = period === 'yearly' ? 12 : 1;
  const elapsed = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  const at = (months: number) => {
    const date = new Date(start); date.setUTCDate(1); date.setUTCMonth(start.getUTCMonth() + months);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(start.getUTCDate(), last)); return date;
  };
  let months = Math.floor(elapsed / step) * step;
  if (at(months) > now) months -= step;
  return at(Math.max(0, months)).toISOString();
}

export function backfillUserPlan(plan: any, definitions: FeatureDefinition[], actual: BackfillUsage,
  now = new Date()) {
  const legacy = Number(plan.entitlement_version ?? 1) < 2;
  const limits = normalizeConfigs(plan.limits, plan.billing_cycle, 'limits', definitions);
  for (const key of requiredPlanFeatures) if (!Object.prototype.hasOwnProperty.call(limits, key)) {
    // Missing v2 features were denied already; show them explicitly without granting access.
    const limit = !legacy ? 0 : plan.billing_cycle === 'Free' && !['Contact', 'Campaign'].includes(key)
      ? trialDefaults[key] : paidDefaults[key];
    limits[key] = { limit, enabled: legacy, reset_period: defaultPeriod(key, plan.billing_cycle, definitions) };
  }
  // v1 treated omitted registry keys as unlimited. Do not lose that behavior when promoting to v2.
  if (legacy) for (const { key } of definitions) if (!limits[key]) {
    limits[key] = { limit: null, enabled: true, reset_period: defaultPeriod(key, plan.billing_cycle, definitions) };
  }
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(jsonObject(plan.usage, 'usage'))) {
    const canonical = keyOf(key);
    usage[canonical] = Math.max(usage[canonical] ?? 0, usageValue(value, key));
  }
  const periods = canonicalEntries(plan.usage_periods, 'usage_periods');
  const validNow = plan.active === true && new Date(plan.start_date) <= now && new Date(plan.end_date) > now;
  for (const [key, config] of Object.entries(limits)) {
    usage[key] ??= 0;
    if (legacy && validNow && actual.capacity[key] !== undefined) usage[key] = actual.capacity[key];
    if (legacy && validNow && key === 'Campaign') usage[key] = Math.max(usage[key], actual.campaigns);
    const addon = usageValue(config.addon_limit, `${key}.addon_limit`);
    if (config.limit !== null && !Number.isSafeInteger(config.limit + addon)) throw new Error(`Unsafe effective limit: ${key}`);
    if (legacy && validNow && config.enabled !== false && config.limit !== null && usage[key] > config.limit + addon) {
      config.legacy_base_limit ??= config.limit;
      config.limit = usage[key] - addon;
      config.grandfathered_at = now.toISOString();
    }
    if (legacy && config.reset_period !== 'never') {
      // Mark the existing usage as belonging to this period; migration must not reset it to zero.
      const effectiveNow = new Date(Math.min(now.getTime(), new Date(plan.end_date).getTime() - 1));
      periods[key] = backfillPeriodStart(new Date(plan.start_date), effectiveNow, config.reset_period);
    }
  }
  return { limits, usage, usage_periods: periods, entitlement_version: Math.max(2, Number(plan.entitlement_version ?? 1)) };
}

export function equivalentJson(left: any, right: any): boolean {
  const sorted = (value: any): any => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
    : Array.isArray(value) ? value.map(sorted) : value;
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}
