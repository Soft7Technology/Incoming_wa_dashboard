import { Knex } from 'knex';
import { backfillSubscription, backfillUserPlan, backfillPeriodStart, equivalentJson,
  FeatureDefinition, jsonObject } from '../utils/legacyPlanEntitlements';

const auditTable = 'plan_entitlement_backfill_audit';
const snapshotFields = ['limits', 'usage', 'usage_periods', 'entitlement_version'];
const catalogFields = ['features', 'trial_days'];
function pick(row: any, fields: string[]) {
  return Object.fromEntries(fields.map(key => [key, row[key]]));
}
function changed(row: any, values: any) {
  return !equivalentJson(pick(row, Object.keys(values)), values);
}
async function updateSnapshots(knex: Knex, table: string, changes: Array<{ id: string; values: any }>) {
  if (!changes.length) return;
  const payload = JSON.stringify(changes.map(change => ({ id: change.id, ...change.values })));
  if (table === 'subscription_plans') await knex.raw(`UPDATE subscription_plans AS p
    SET features = v.features, trial_days = v.trial_days
    FROM jsonb_to_recordset(?::jsonb) AS v(id uuid, features jsonb, trial_days integer)
    WHERE p.id = v.id`, [payload]);
  else if (table === 'user_plans') await knex.raw(`UPDATE user_plans AS p
    SET limits = v.limits, usage = v.usage, usage_periods = v.usage_periods, entitlement_version = v.entitlement_version
    FROM jsonb_to_recordset(?::jsonb) AS v(id uuid, limits jsonb, usage jsonb, usage_periods jsonb, entitlement_version integer)
    WHERE p.id = v.id`, [payload]);
  else throw new Error('Unsupported plan backfill table');
}

async function resourceCounts(knex: Knex, ownerIds: string[]) {
  const counts: Record<string, Record<string, number>> = {};
  const tables = [ ['Contact', 'contacts', 'user_id'], ['Chatbot', 'chat_bot', 'user_id'],
    ['AiAssistant', 'ai_assistants', 'user_id'], ['WabaNumber', 'phone_numbers', 'user_id'],
    ['TeamInvite', 'user_team', 'invite_sent_by'] ];
  for (const [key, table, ownerColumn] of tables) {
    const query = knex(table).whereIn(ownerColumn, ownerIds).select(ownerColumn).count('* as total').groupBy(ownerColumn);
    if (key === 'Contact' || key === 'WabaNumber') query.whereNull('deleted_at');
    if (key === 'WabaNumber') query.where({ active: true });
    if (key === 'TeamInvite') query.whereIn('invite_status', ['sent', 'accepted']);
    for (const row of await query) {
      counts[row[ownerColumn]] ??= {};
      counts[row[ownerColumn]][key] = Number(row.total);
    }
  }
  return counts;
}

/** Shared by the read-only preview and migration; no writes or row locks here. */
export async function previewBackfill(knex: Knex, now = new Date(), lockedRows?: { catalog: any[]; plans: any[] }) {
  const catalog = lockedRows?.catalog ?? await knex('subscription_plans').orderBy('id');
  const plans = lockedRows?.plans ?? await knex('user_plans').orderBy('id');
  const definitions: FeatureDefinition[] = await knex('plan_features').select('key', 'kind');
  // Keep the existing API access feature editable through catalog validation. This is
  // registration only; no new quota hook or paid add-on is introduced for it.
  const hasLegacyApi = [...catalog.map(plan => plan.features), ...plans.map(plan => plan.limits)]
    .some(value => Object.prototype.hasOwnProperty.call(jsonObject(value, 'legacy features'), 'developer_api'));
  const featureChanges = hasLegacyApi && !definitions.some(row => row.key === 'developer_api') ? [{
    id: 'developer_api', before: null, after: { key: 'developer_api', label: 'Developer API', kind: 'capacity',
      description: 'Existing developer API entitlement retained during plan backfill', addon_allowed: false, active: true },
  }] : [];
  definitions.push(...featureChanges.map(change => ({ key: change.after.key, kind: change.after.kind })));
  const current = plans.filter(plan => plan.entitlement_version < 2 && plan.active &&
    new Date(plan.start_date) <= now && new Date(plan.end_date) > now);
  const counts = await resourceCounts(knex, [...new Set(current.map(plan => plan.user_id))]);
  const campaignCounts = new Map<string, number>();
  if (current.length) {
    // One grouped query, rather than counting campaigns separately for every user.
    const ranges = current.map(plan => {
      const normalized = backfillUserPlan(plan, definitions, { capacity: {}, campaigns: 0 }, now);
      return [plan.id, plan.user_id, backfillPeriodStart(new Date(plan.start_date), now,
        normalized.limits.Campaign.reset_period), new Date(Math.min(now.getTime(), new Date(plan.end_date).getTime()))];
    });
    const result = await knex.raw(`SELECT r.id, count(c.id)::int AS total
      FROM (VALUES ${ranges.map(() => '(?::uuid, ?::uuid, ?::timestamptz, ?::timestamptz)').join(',')}) AS r(id, user_id, period_start, period_end)
      LEFT JOIN campaigns c ON c.user_id = r.user_id AND c.created_at >= r.period_start AND c.created_at < r.period_end
      GROUP BY r.id`, ranges.flat());
    for (const row of result.rows) campaignCounts.set(row.id, Number(row.total));
  }
  const catalogChanges = catalog.map(row => ({ id: row.id, before: pick(row, catalogFields),
    after: { ...pick(row, catalogFields), ...backfillSubscription(row, definitions) } }))
    .filter(change => !equivalentJson(change.before, change.after));
  const userChanges = plans.map(row => {
    const actual = { capacity: { Contact: 0, Chatbot: 0, AiAssistant: 0, WabaNumber: 0, TeamInvite: 0,
      ...counts[row.user_id] }, campaigns: campaignCounts.get(row.id) ?? 0 };
    const after = backfillUserPlan(row, definitions, actual, now);
    return { id: row.id, before: pick(row, snapshotFields), after };
  }).filter(change => !equivalentJson(change.before, change.after));
  const protectedCounts: Record<string, number> = {};
  for (const change of userChanges) for (const [key, config] of Object.entries(change.after.limits)) {
    if ((config as any).grandfathered_at === now.toISOString()) protectedCounts[key] = (protectedCounts[key] ?? 0) + 1;
  }
  return { featureChanges, catalogChanges, userChanges, summary: { legacy_features_to_register: featureChanges.length,
    subscription_plans: catalog.length, subscription_plans_to_update: catalogChanges.length,
    user_plans: plans.length, user_plans_to_update: userChanges.length, current_legacy_plans: current.length,
    protected_allowances: protectedCounts } };
}

export async function up(knex: Knex): Promise<void> {
  // Knex runs this migration in one transaction. Lock catalog -> owners -> plan snapshots,
  // matching assignment and resource creation, before reading usage and computing changes.
  const catalog = await knex('subscription_plans').orderBy('id').forUpdate();
  const initial = await knex('user_plans').select('id', 'user_id');
  await knex('users').whereIn('id', [...new Set(initial.map(row => row.user_id))]).orderBy('id').forUpdate().select('id');
  const plans = await knex('user_plans').whereIn('id', initial.map(row => row.id)).orderBy('id').forUpdate();
  const preview = await previewBackfill(knex, new Date(), { catalog, plans });
  await knex.schema.createTable(auditTable, table => {
    table.string('resource_type', 32).notNullable();
    table.string('resource_id', 64).notNullable();
    table.jsonb('previous_values').notNullable();
    table.jsonb('applied_values').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(['resource_type', 'resource_id']);
  });
  if (preview.featureChanges.length) await knex('plan_features').insert(preview.featureChanges.map(change => change.after));
  const batches = [['plan_features', preview.featureChanges], ['subscription_plans', preview.catalogChanges], ['user_plans', preview.userChanges]] as const;
  const audit = batches.flatMap(([table, changes]) => changes.map(change => ({ resource_type: table, resource_id: change.id,
    previous_values: JSON.stringify(change.before), applied_values: JSON.stringify(change.after) })));
  if (audit.length) await knex(auditTable).insert(audit);
  for (const [table, changes] of batches) if (table !== 'plan_features') {
    await updateSnapshots(knex, table, changes.map(change => ({ id: change.id, values: change.after })));
  }
}

export async function down(knex: Knex): Promise<void> {
  // Refuse rollback after a plan is edited/used rather than overwriting its newer state.
  const records = await knex(auditTable).orderBy('resource_type').orderBy('resource_id');
  if (records.some(record => !['plan_features', 'subscription_plans', 'user_plans'].includes(record.resource_type))) throw new Error('Invalid plan audit resource');
  for (const table of ['subscription_plans', 'user_plans', 'plan_features']) {
    const entries = records.filter(record => record.resource_type === table);
    const key = table === 'plan_features' ? 'key' : 'id';
    const current = new Map((await knex(table).whereIn(key, entries.map(record => record.resource_id))
      .orderBy(key).forUpdate()).map(row => [row[key], row]));
    const existing = entries.filter(record => current.has(record.resource_id));
    for (const record of existing) if (changed(current.get(record.resource_id), record.applied_values)) throw new Error(
      `Cannot restore ${table}/${record.resource_id}: entitlements changed after backfill; review the saved audit values`);
    if (table === 'plan_features') {
      await knex(table).whereIn(key, existing.map(record => record.resource_id)).delete();
    } else await updateSnapshots(knex, table, existing.map(record => ({ id: record.resource_id, values: record.previous_values })));
  }
  await knex.schema.dropTable(auditTable);
}
