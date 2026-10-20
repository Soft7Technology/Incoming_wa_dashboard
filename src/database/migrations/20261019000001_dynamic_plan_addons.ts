import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('plan_features', (t) => {
    t.string('key', 64).primary();
    t.string('label', 100).notNullable();
    t.string('description', 500).notNullable().defaultTo('');
    t.string('kind', 16).notNullable();
    t.boolean('addon_allowed').notNullable().defaultTo(true);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });
  await knex.raw("ALTER TABLE plan_features ADD CONSTRAINT plan_features_kind CHECK (kind IN ('capacity', 'usage'))");
  await knex('plan_features').insert([
    {
      key: 'TeamInvite',
      label: 'Team Members',
      kind: 'capacity',
      description: 'Pending and accepted team invitations; excludes the owner',
    },
    { key: 'Contact', label: 'Contacts', kind: 'capacity', description: 'Stored contacts, excluding deleted contacts' },
    {
      key: 'Campaign',
      label: 'Campaigns',
      kind: 'usage',
      description: 'Campaigns created during the configured usage period',
    },
    { key: 'WabaNumber', label: 'WABA Numbers', kind: 'capacity', description: 'Connected WhatsApp phone numbers' },
    { key: 'Chatbot', label: 'Chatbots', kind: 'capacity', description: 'Stored chatbots, including drafts' },
    {
      key: 'AiAssistant',
      label: 'AI Assistants',
      kind: 'capacity',
      description: 'Stored AI assistants, including inactive assistants',
    },
    { key: 'Message', label: 'Messages', kind: 'usage' },
    { key: 'Tag', label: 'Tags', kind: 'usage' },
  ]);
  await knex.schema.alterTable('user_plans', (t) => {
    t.integer('entitlement_version').notNullable().defaultTo(1);
    t.jsonb('usage_periods').notNullable().defaultTo('{}');
  });
  await knex.schema.createTable('plan_addons', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 100).notNullable();
    t.string('feature_key', 64).notNullable().references('key').inTable('plan_features').onDelete('RESTRICT');
    t.integer('units').notNullable();
    t.integer('price_paise').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });
  await knex.raw('ALTER TABLE plan_addons ADD CONSTRAINT plan_addons_positive CHECK (units > 0 AND price_paise > 0)');
  await knex.schema.createTable('user_plan_addons', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('RESTRICT');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.uuid('user_plan_id').notNullable().references('id').inTable('user_plans').onDelete('RESTRICT');
    t.uuid('addon_id').notNullable().references('id').inTable('plan_addons').onDelete('RESTRICT');
    t.uuid('purchased_by').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.string('idempotency_key', 100).notNullable();
    t.string('request_hash', 64).notNullable();
    t.string('feature_key', 64).notNullable();
    t.integer('quantity').notNullable();
    t.bigInteger('units').notNullable();
    t.bigInteger('amount_paise').notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamps(true, true);
    t.unique(['company_id', 'idempotency_key']);
    t.index(['user_plan_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('user_plan_addons');
  await knex.schema.dropTable('plan_addons');
  await knex.schema.alterTable('user_plans', (t) => {
    t.dropColumn('usage_periods');
    t.dropColumn('entitlement_version');
  });
  await knex.schema.dropTable('plan_features');
}
