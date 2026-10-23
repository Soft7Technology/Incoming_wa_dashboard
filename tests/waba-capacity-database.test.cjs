const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const knex = require('knex');

function load(file, dependencies = {}) {
  const exports = {};
  const normalize = id => id.startsWith('@surefy/') ? path.resolve('library/surefy/src', id.slice(8)) : id.startsWith('.') ? path.resolve(path.dirname(file), id) : id;
  const injected = new Map(Object.entries(dependencies).map(([id, value]) => [normalize(id), value]));
  const compiled = process.env.WABA_CAPACITY_TEST_COMPILED_ROOT;
  const code = compiled ? fs.readFileSync(path.join(compiled, file.replace(/\.ts$/, '.js')), 'utf8') : require('typescript').transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: 7, module: 1, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, require: id => injected.has(normalize(id)) ? injected.get(normalize(id)) : require(id), process, Buffer, Date, console }, { filename: file });
  return exports;
}
const errors = {};
for (const statusCode of [400, 403, 404]) errors['@surefy/exceptions/HTTP' + statusCode + 'Error'] = class extends Error {
  constructor({ message, details }) { super(message); this.statusCode = statusCode; this.details = details; }
};
const es = value => ({ __esModule: true, default: value });

test('WABA capacity: real PostgreSQL allocation, legacy add-ons, concurrency and plan failures', { skip: !process.env.WABA_CAPACITY_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.WABA_CAPACITY_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.ok(url.pathname.includes('waba_capacity_test'), 'Use a fresh disposable waba_capacity_test database');
  const db = knex({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 6 } });
  try {
    assert.equal(await db.schema.hasTable('users'), false, 'Disposable database must be empty');
    await db.schema.createTable('users', table => { table.uuid('id').primary(); });
    await db.schema.createTable('user_plans', table => {
      table.uuid('id').primary(); table.uuid('user_id'); table.boolean('active'); table.text('plan_name'); table.text('billing_cycle');
      table.timestamp('start_date'); table.timestamp('end_date'); table.integer('entitlement_version');
      table.jsonb('limits'); table.jsonb('usage'); table.jsonb('usage_periods'); table.jsonb('addons');
    });
    await db.schema.createTable('waba_accounts', table => {
      table.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()')); table.uuid('user_id'); table.uuid('company_id'); table.text('waba_id').unique();
      for (const column of ['name', 'currency', 'timezone', 'message_template_namespace', 'connection_status']) table.text(column);
      table.jsonb('meta_data'); table.timestamp('deleted_at'); table.timestamp('updated_at'); table.timestamp('last_synced_at');
    });
    await db.schema.createTable('phone_numbers', table => {
      table.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()')); table.uuid('user_id'); table.uuid('company_id'); table.uuid('waba_id');
      table.text('phone_number_id').unique(); table.text('display_phone_number'); table.text('verified_name'); table.text('quality_rating');
      table.text('code_verification_status'); table.text('connection_status'); table.text('status').defaultTo('active');
      table.boolean('active').defaultTo(true); table.text('inactive_reason'); table.jsonb('meta_data'); table.timestamp('deleted_at');
      table.timestamp('created_at').defaultTo(db.fn.now()); table.timestamp('updated_at');
    });
    const features = load('src/app/utils/planFeatures.ts', errors);
    const usage = load('src/app/services/planUsage.service.ts', { ...errors, '@surefy/database': db, '../utils/planFeatures': features }).default;
    const base = load('library/surefy/src/models/base.model.ts', { '../database': db });
    const model = load('src/app/models/waba.model.ts', { ...errors, '@surefy/models/base.model': base, '../services/planUsage.service': es(usage) }).default;
    const phoneModel = load('src/app/models/phoneNumber.model.ts', { '@surefy/models/base.model': base, '../services/planUsage.service': es(usage) }).default;
    let metaId = 8000000000;
    const phone = () => ({ id: String(++metaId), display_phone_number: '+1 555 010 0001', verified_name: 'Test number' });
    async function seed(limit, addon = 0, changes = {}) {
      const userId = randomUUID(), companyId = randomUUID();
      await db('users').insert({ id: userId });
      if (!changes.absent) await db('user_plans').insert({ id: randomUUID(), user_id: userId, active: true,
        plan_name: 'Disposable test plan', billing_cycle: 'Monthly', start_date: new Date(Date.now() - 86400000),
        end_date: changes.expired ? new Date(0) : new Date(Date.now() + 86400000), entitlement_version: 2,
        limits: JSON.stringify({ WabaNumber: { limit, addon_limit: addon, enabled: !changes.disabled, reset_period: 'never' } }),
        usage: JSON.stringify({ WabaNumber: 0 }) });
      const accounts = await db('waba_accounts').insert([0, 1].map(() => ({ user_id: userId, company_id: companyId,
        waba_id: String(++metaId), name: 'Disposable WABA', connection_status: 'legacy', meta_data: '{}' }))).returning('*');
      return { userId, companyId, accounts };
    }
    async function stored(account, value = phone(), changes = {}) {
      return (await db('phone_numbers').insert({ user_id: account.user_id, company_id: account.company_id, waba_id: account.id,
        phone_number_id: value.id, display_phone_number: value.display_phone_number, ...changes }).returning('*'))[0];
    }

    await t.test('three base plus a text two add-on allows five; one remaining slot saves only one of two new numbers', async () => {
      const f = await seed(3, '2');
      for (let i = 0; i < 4; i++) await stored(f.accounts[0]);
      const incoming = [phone(), phone()];
      const result = await model.syncAccountAndPhones(f.accounts[1], {}, incoming);
      assert.equal(result.created, 1); assert.equal(result.skipped_count, 1); assert.equal(result.remaining_slots, 0);
      assert.equal(result.skipped_phone_numbers[0].phone_number_id, incoming[1].id);
      assert.equal(Number((await db('phone_numbers').where({ user_id: f.userId }).count('* as n').first()).n), 5);
      const repeat = await model.syncAccountAndPhones(f.accounts[1], {}, incoming);
      assert.equal(repeat.created, 0); assert.equal(repeat.updated, 1); assert.equal(repeat.skipped_count, 1);
      const summary = (await usage.summary(f.userId)).features.WabaNumber;
      assert.equal(summary.effective_limit, 5); assert.equal(summary.used, 5); assert.equal(summary.remaining, 0);
      assert.equal((await db('user_plans').where({ user_id: f.userId }).first()).usage.WabaNumber, 5);
      await db('user_plans').where({ user_id: f.userId }).update({ limits: JSON.stringify({ WabaNumber: { limit: 3, addon_limit: 3 } }) });
      const upgraded = await model.syncAccountAndPhones(f.accounts[1], {}, incoming);
      assert.equal(upgraded.created, 1); assert.equal(upgraded.skipped_count, 0);
    });

    await t.test('two concurrent WABAs cannot claim the same last slot; direct creation also rejects at capacity', async () => {
      const f = await seed(1);
      const results = await Promise.all(f.accounts.map(account => model.syncAccountAndPhones(account, {}, [phone()])));
      assert.equal(results.reduce((sum, r) => sum + r.created, 0), 1);
      assert.equal(results.reduce((sum, r) => sum + r.skipped_count, 0), 1);
      assert.equal(Number((await db('phone_numbers').where({ user_id: f.userId }).count('* as n').first()).n), 1);
      const incoming = phone();
      await assert.rejects(phoneModel.create({ user_id: f.userId, company_id: f.companyId, waba_id: f.accounts[0].id,
        phone_number_id: incoming.id, display_phone_number: incoming.display_phone_number }), error => error.statusCode === 403 && error.details.code === 'PLAN_LIMIT_EXCEEDED');
      await db('phone_numbers').where({ user_id: f.userId }).update({ active: false, inactive_reason: 'MANUALLY_DISABLED' });
      const created = await phoneModel.create({ user_id: f.userId, company_id: f.companyId, waba_id: f.accounts[0].id,
        phone_number_id: incoming.id, display_phone_number: incoming.display_phone_number });
      assert.equal(created.active, true);
      assert.equal((await db('user_plans').where({ user_id: f.userId }).first()).usage.WabaNumber, 1);
    });

    await t.test('zero, invalid, disabled, expired and missing entitlements skip new inventory instead of storing inactive rows', async () => {
      for (const [limit, addon, changes] of [[0, 0, {}], [2, 'bad', {}], [2, 0, { disabled: true }], [2, 0, { expired: true }], [2, 0, { absent: true }]]) {
        const f = await seed(limit, addon, changes);
        const result = await model.syncAccountAndPhones(f.accounts[0], {}, [phone(), phone()]);
        assert.equal(result.created, 0); assert.equal(result.phone_numbers.length, 0); assert.equal(result.skipped_count, 2);
        assert.equal(Number((await db('phone_numbers').where({ user_id: f.userId }).count('* as n').first()).n), 0);
        assert.equal(result.skipped_phone_numbers[0].reason, limit === 0 ? 'PLAN_LIMIT_EXCEEDED' : 'PLAN_UNAVAILABLE');
      }
    });

    await t.test('a downgrade retains existing rows and manual settings; a deleted number is not restored without a slot', async () => {
      const f = await seed(1);
      for (let i = 0; i < 3; i++) await stored(f.accounts[0]);
      const deleted = phone(); await stored(f.accounts[0], deleted, { active: false, deleted_at: new Date(0) });
      const result = await model.syncAccountAndPhones(f.accounts[0], {}, [deleted, phone()]);
      assert.equal(result.created, 0); assert.equal(result.skipped_count, 2);
      assert.equal(Number((await db('phone_numbers').where({ user_id: f.userId, active: true }).whereNull('deleted_at').count('* as n').first()).n), 1);
      assert.notEqual((await db('phone_numbers').where({ phone_number_id: deleted.id }).first()).deleted_at, null);
      assert.equal(Number((await db('phone_numbers').where({ user_id: f.userId }).count('* as n').first()).n), 4);
      assert.equal((await db('user_plans').where({ user_id: f.userId }).first()).usage.WabaNumber, 1);
    });

    await t.test('foreign number conflicts roll back the whole allocation and leave another owner untouched', async () => {
      const f = await seed(1), foreign = await seed(1), value = phone();
      await stored(foreign.accounts[0], value);
      await assert.rejects(model.syncAccountAndPhones(f.accounts[0], { name: 'Must roll back' }, [value]), /another account/);
      assert.equal((await db('waba_accounts').where({ id: f.accounts[0].id }).first()).name, 'Disposable WABA');
      assert.equal((await db('phone_numbers').where({ phone_number_id: value.id }).first()).user_id, foreign.userId);
      assert.equal((await db('user_plans').where({ user_id: f.userId }).first()).usage.WabaNumber, 0);
    });
  } finally { await db.destroy(); }
});
