const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('PostgreSQL cleanup removes only unmetered quotas and selections, preserves receipts, and safely rolls back',
  { skip: process.env.UNMETERED_FEATURES_DATABASE_TEST !== 'true' }, async () => {
    require('dotenv').config({ quiet: true }); require('ts-node/register');
    const config = require('../library/surefy/src/config/knex.config').default.development;
    const db = require('knex')({ ...config, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });
    const migration = require('../src/database/migrations/20261020000001_unmetered_tags_messages_columns');
    const schema = 'unmetered_test_' + crypto.randomUUID().replaceAll('-', '');
    const marker = Error('ROLLBACK_UNMETERED_TEST');
    const tagId = crypto.randomUUID(), contactId = crypto.randomUUID();
    try {
      await assert.rejects(db.transaction(async trx => {
        // An isolated schema ensures the migration cannot touch actual customer tables.
        await trx.schema.createSchema(schema);
        await trx.raw('SET LOCAL search_path TO ??', [schema]);
        await trx.schema.createTable('subscription_plans', t => { t.uuid('id').primary(); t.jsonb('features'); t.jsonb('addons'); t.integer('price'); });
        await trx.schema.createTable('user_plans', t => { t.uuid('id').primary();
          for (const name of ['limits', 'usage', 'usage_periods', 'addons']) t.jsonb(name);
          t.boolean('active');
        });
        await trx.schema.createTable('plan_features', t => { t.string('key').primary(); t.boolean('active'); t.boolean('addon_allowed'); });
        await trx.schema.createTable('plan_addons', t => { t.uuid('id').primary(); t.string('feature_key'); t.boolean('active'); t.integer('price_paise'); });
        await trx.schema.createTable('user_plan_addons', t => { t.uuid('id').primary(); t.uuid('addon_id'); t.integer('amount_paise'); });
        await trx('plan_features').insert(['Tag', 'Message', 'CustomColumn', 'Contact', 'Campaign'].map(key => ({ key, active: true, addon_allowed: true })));
        await trx('plan_addons').insert([{ id: tagId, feature_key: 'Tag', active: true, price_paise: 2000 },
          { id: contactId, feature_key: 'Contact', active: true, price_paise: 2000 }]);
        const addons = [{ addon_id: tagId, enabled: true }, { addon_id: contactId, enabled: false }];
        const featureMap = { Tag: { limit_value: 1 }, Message: { limit_value: null }, custom_columns: { limit_value: 0 }, Contact: { limit_value: 3000 } };
        const planId = crypto.randomUUID(), userPlanId = crypto.randomUUID(), nullPlanId = crypto.randomUUID();
        await trx('subscription_plans').insert({ id: planId, price: 200, features: JSON.stringify(featureMap), addons: JSON.stringify(addons) });
        await trx('user_plans').insert([{ id: userPlanId, active: true,
          limits: JSON.stringify({ Tag: { enabled: false, limit: 0 }, Message: { limit: 5 }, Column: { limit: null }, Contact: { limit: 3000, addon_limit: 3000 } }),
          usage: JSON.stringify({ tags: 2, messages: 4, create_columns: 5, Contact: 10 }),
          usage_periods: JSON.stringify({ Message: '2026-10-01', Campaign: '2026-10-01' }), addons: JSON.stringify(addons) },
          { id: nullPlanId, active: false, limits: '{}', usage: '{}', usage_periods: '{}', addons: null }]);
        await trx('user_plan_addons').insert({ id: crypto.randomUUID(), addon_id: tagId, amount_paise: 2000 });
        const original = await trx('user_plans').where({ id: userPlanId }).first();
        await migration.up(trx);
        const catalog = await trx('subscription_plans').where({ id: planId }).first();
        assert.deepEqual(catalog.features, { Contact: { limit_value: 3000 } });
        assert.equal(catalog.price, 200);
        assert.deepEqual(catalog.addons, [addons[1]]);
        const saved = await trx('user_plans').where({ id: userPlanId }).first();
        assert.deepEqual(saved.limits, { Contact: { limit: 3000, addon_limit: 3000 } });
        assert.deepEqual(saved.usage, { Contact: 10 });
        assert.deepEqual(saved.usage_periods, { Campaign: '2026-10-01' });
        assert.deepEqual(saved.addons, [addons[1]]);
        assert.equal((await trx('user_plans').where({ id: nullPlanId }).first()).addons, null);
        assert.equal((await trx('plan_features').where({ key: 'Tag' }).first()).active, false);
        assert.equal((await trx('plan_addons').where({ id: tagId }).first()).active, false);
        assert.equal((await trx('plan_addons').where({ id: contactId }).first()).active, true);
        assert.equal((await trx('user_plan_addons').first()).amount_paise, 2000);
        // Changes since migration must not be overwritten by rollback.
        await trx('user_plans').where({ id: userPlanId }).update({ usage: JSON.stringify({ Contact: 11 }) });
        await assert.rejects(migration.down(trx), /changed after/);
        await trx('user_plans').where({ id: userPlanId }).update({ usage: JSON.stringify(saved.usage) });
        await migration.down(trx);
        assert.deepEqual(await trx('user_plans').where({ id: userPlanId }).first(), original);
        assert.equal((await trx('plan_addons').where({ id: tagId }).first()).active, true);
        throw marker;
      }), error => error === marker);
      assert.equal((await db.raw('SELECT 1 FROM pg_namespace WHERE nspname = ?', [schema])).rows.length, 0);
    } finally { await db.destroy(); }
  });
