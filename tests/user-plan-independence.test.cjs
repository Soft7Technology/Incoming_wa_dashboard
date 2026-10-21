const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadSource } = require('./helpers/background-database.cjs');
const migrationPath = 'src/database/migrations/20261021000001_independent_user_plans.ts';

test('PostgreSQL migration preserves active, historical and pending snapshots when catalog plans are deleted',
  { skip: process.env.USER_PLAN_INDEPENDENCE_DATABASE_TEST !== 'true' }, async () => {
    require('dotenv').config({ quiet: true });
    const db = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL,
      pool: { min: 0, max: 1 }, acquireConnectionTimeout: 10000 });
    const migration = loadSource(migrationPath);
    const schema = 'independent_plans_test_' + crypto.randomUUID().replaceAll('-', '');
    const marker = Error('ROLLBACK_INDEPENDENT_PLANS_TEST');
    try {
      await assert.rejects(db.transaction(async trx => {
        await trx.schema.createSchema(schema);
        await trx.raw('SET LOCAL search_path TO ??', [schema]);
        assert.equal((await trx.raw('SELECT current_schema() AS schema')).rows[0].schema, schema);
        await trx.schema.createTable('subscription_plans', t => { t.uuid('id').primary(); t.string('plan_name'); });
        await trx.schema.createTable('user_plans', t => {
          t.uuid('id').primary();
          t.uuid('subscription_id').notNullable().references('id').inTable('subscription_plans').onDelete('CASCADE');
          t.uuid('user_id'); t.uuid('company_id'); t.string('plan_name'); t.decimal('price', 10, 2);
          t.string('billing_cycle'); t.string('status'); t.boolean('active');
          t.timestamp('start_date', { useTz: true }); t.timestamp('end_date', { useTz: true });
          t.jsonb('limits'); t.jsonb('usage'); t.jsonb('addons'); t.integer('platform_fee_paise');
        });
        await trx.schema.createTable('users', t => {
          t.uuid('id').primary(); t.uuid('assigned_plan').references('id').inTable('user_plans').onDelete('SET NULL');
        });
        await trx.schema.createTable('company_payment_orders', t => {
          t.uuid('id').primary(); t.uuid('user_plan_id').references('id').inTable('user_plans').onDelete('RESTRICT');
        });
        const sourceId = crypto.randomUUID(), otherSourceId = crypto.randomUUID();
        const owner = crypto.randomUUID(), company = crypto.randomUUID();
        await trx('subscription_plans').insert([{ id: sourceId, plan_name: 'Original' }, { id: otherSourceId, plan_name: 'Other' }]);
        const snapshots = ['COMPLETED', 'EXPIRED', 'pending'].map((status, i) => ({
          id: crypto.randomUUID(), subscription_id: sourceId, user_id: owner, company_id: company,
          plan_name: 'Purchased Name', price: '149.50', billing_cycle: 'Monthly', status, active: i === 0,
          start_date: '2026-10-01T00:00:00.000Z', end_date: '2026-11-01T00:00:00.000Z',
          limits: JSON.stringify({ Contact: { limit: 5000 } }), usage: JSON.stringify({ Contact: 42 }),
          addons: JSON.stringify([{ addon_id: crypto.randomUUID(), enabled: true }]), platform_fee_paise: 10000,
        }));
        await trx('user_plans').insert(snapshots);
        await trx('users').insert({ id: owner, assigned_plan: snapshots[0].id });
        const order = { id: crypto.randomUUID(), user_plan_id: snapshots[2].id };
        await trx('company_payment_orders').insert(order);
        const before = (await trx('user_plans').orderBy('id')).map(({ subscription_id, ...snapshot }) => snapshot);

        await migration.up(trx);
        assert.equal(await trx.schema.hasColumn('user_plans', 'subscription_id'), false);
        await trx('subscription_plans').where({ id: sourceId }).del();
        assert.deepEqual(await trx('user_plans').orderBy('id'), before);
        assert.equal((await trx('users').where({ id: owner }).first()).assigned_plan, snapshots[0].id);
        assert.deepEqual(await trx('company_payment_orders').first(), order);
        // Further independent snapshots require no source plan at all.
        const { subscription_id, ...standalone } = snapshots[0];
        standalone.id = crypto.randomUUID();
        await trx('user_plans').insert(standalone);
        await migration.up(trx); // Safe on an already migrated schema.

        await migration.down(trx);
        assert.equal((await trx('user_plans').where({ id: standalone.id }).first()).subscription_id, null);
        await trx('user_plans').where({ id: standalone.id }).update({ subscription_id: otherSourceId });
        await trx('subscription_plans').where({ id: otherSourceId }).del();
        assert.equal((await trx('user_plans').where({ id: standalone.id }).first()).subscription_id, null);
        assert.equal(Number((await trx('user_plans').count('* AS total').first()).total), 4);
        throw marker;
      }), error => error === marker);
    } finally { await db.destroy(); }
  });
