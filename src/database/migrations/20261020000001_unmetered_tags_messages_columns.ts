import { Knex } from 'knex';

// Frozen policy aliases: future application changes must not change this migration.
const aliases = ['tag', 'tags', 'message', 'messages', 'column', 'columns',
  'customcolumn', 'customcolumns', 'contactcolumn', 'contactcolumns', 'createcolumn', 'createcolumns'];
const auditTable = 'unmetered_plan_features_audit';
const resources = [
  { table: 'subscription_plans', key: 'id', fields: ['features', 'addons'] },
  { table: 'user_plans', key: 'id', fields: ['limits', 'usage', 'usage_periods', 'addons'] },
  { table: 'plan_features', key: 'key', fields: ['active', 'addon_allowed'] },
  { table: 'plan_addons', key: 'id', fields: ['active'] },
];
const matches = (expression: string) =>
  `lower(regexp_replace(${expression}, '[_[:space:]-]', '', 'g')) IN (${aliases.map(key => `'${key}'`).join(',')})`;
const values = (fields: string[], expression: (field: string) => string) =>
  `jsonb_build_object(${fields.map(field => `'${field}', ${expression(field)}`).join(', ')})`;

async function applyAudit(knex: Knex, source: 'previous_values' | 'applied_values') {
  for (const { table, key, fields } of resources) {
    await knex.raw(`UPDATE ${table} p SET ${fields.map(field =>
      `${field} = (jsonb_populate_record(NULL::${table}, a.${source})).${field}`).join(', ')}
      FROM ${auditTable} a WHERE a.resource_type = ? AND p.${key}::text = a.resource_id`, [table]);
  }
}

export async function up(knex: Knex): Promise<void> {
  // Knex's migration transaction makes the audit and policy changes atomic.
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex.raw("SET LOCAL statement_timeout = '60s'");
  await knex.raw('LOCK TABLE subscription_plans, user_plans, plan_features, plan_addons IN SHARE ROW EXCLUSIVE MODE');
  await knex.schema.createTable(auditTable, table => {
    table.string('resource_type', 32).notNullable();
    table.string('resource_id', 64).notNullable();
    table.jsonb('previous_values').notNullable();
    table.jsonb('applied_values').notNullable();
    table.primary(['resource_type', 'resource_id']);
  });
  for (const { table, key, fields } of resources) {
    const before = values(fields, field => `p.${field}`);
    const after = values(fields, field => {
      if (field === 'active' || field === 'addon_allowed') return 'false';
      if (field === 'addons') return `CASE WHEN jsonb_typeof(p.addons) = 'array' THEN
        COALESCE((SELECT jsonb_agg(item ORDER BY position) FROM jsonb_array_elements(p.addons)
          WITH ORDINALITY AS selected(item, position) WHERE NOT EXISTS (
            SELECT 1 FROM plan_addons pack WHERE pack.id::text = item->>'addon_id' AND ${matches('pack.feature_key')}
          )), '[]'::jsonb) ELSE p.addons END`;
      return `CASE WHEN jsonb_typeof(p.${field}) = 'object' THEN p.${field} - ARRAY(
        SELECT feature FROM jsonb_object_keys(p.${field}) feature WHERE ${matches('feature')}
      ) ELSE p.${field} END`;
    });
    const condition = table === 'plan_features' ? `WHERE ${matches('p.key')}` :
      table === 'plan_addons' ? `WHERE ${matches('p.feature_key')}` : '';
    await knex.raw(`INSERT INTO ${auditTable} (resource_type, resource_id, previous_values, applied_values)
      SELECT ?, resource_id, previous_values, applied_values FROM (
        SELECT p.${key}::text resource_id, ${before} previous_values, ${after} applied_values
        FROM ${table} p ${condition}
      ) changes WHERE previous_values IS DISTINCT FROM applied_values`, [table]);
  }
  await applyAudit(knex, 'applied_values');
  // Historical user_plan_addons receipts, wallet transactions and resource data remain intact.
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex.raw('LOCK TABLE subscription_plans, user_plans, plan_features, plan_addons IN SHARE ROW EXCLUSIVE MODE');
  // Never overwrite newer plan edits or counters when restoring a previous configuration.
  for (const { table, key, fields } of resources) {
    const changed = await knex.raw(`SELECT 1 FROM ${table} p JOIN ${auditTable} a
      ON a.resource_type = ? AND p.${key}::text = a.resource_id
      WHERE ${values(fields, field => `p.${field}`)} IS DISTINCT FROM a.applied_values LIMIT 1`, [table]);
    if (changed.rows.length) throw new Error('Plan configuration changed after unlimited-feature cleanup; review the saved audit before rollback');
  }
  await applyAudit(knex, 'previous_values');
  await knex.schema.dropTable(auditTable);
}
