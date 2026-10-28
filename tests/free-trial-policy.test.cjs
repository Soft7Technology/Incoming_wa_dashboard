const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, Date, Buffer, process: { env: {} }, console: { log() {}, error() {} },
    require: name => {
      if (name in deps) return deps[name];
      if (name.includes('/exceptions/')) return HttpError;
      if (name.endsWith('/freeTrialPolicy')) return policy;
      if (name.endsWith('/planFeatures')) return featureUtils;
      if (name.endsWith('/subscriptionDuration')) return duration;
      return {};
    } });
  return exports;
}
const duration = load('src/app/utils/subscriptionDuration.ts');
const featureUtils = load('src/app/utils/planFeatures.ts');
const policy = load('src/app/utils/freeTrialPolicy.ts');
const expected = { TeamInvite: 2, Contact: 500, Campaign: 2, WabaNumber: 1, Chatbot: 2, AiAssistant: 1 };

test('trial policy allows only 3/7/10 days, defaults new trials to 10 and always returns fresh fixed limits', () => {
  assert.equal(policy.newTrialDays(), 10);
  for (const days of [3, 7, 10]) assert.equal(policy.newTrialDays(days), days);
  for (const days of [null, '7', 0, 5, 14, 3.5]) assert.throws(() => policy.newTrialDays(days), /3, 7, or 10/);
  const features = policy.freeTrialFeatures();
  assert.deepEqual(Object.fromEntries(Object.entries(features).map(([key, value]) => [key, value.limit_value])), expected);
  features.Contact.limit_value = null;
  assert.equal(policy.freeTrialFeatures().Contact.limit_value, 500);
});

test('trial features cannot be increased, disabled, made unlimited, removed or extended with another key', () => {
  for (const mutate of [f => { f.Contact.limit_value = null; }, f => { f.Campaign.limit_value = 3; },
    f => { f.Chatbot.enabled = false; }, f => { delete f.WabaNumber; },
    f => { f.FutureFeature = { limit_value: 1 }; }, f => { f.Campaign.reset_period = 'monthly'; }]) {
    const features = policy.freeTrialFeatures(); mutate(features);
    assert.throws(() => policy.fixedTrialFeatures(features), /fixed by the platform/);
  }
  assert.equal(policy.fixedTrialFeatures().Contact.limit_value, 500);
  assert.equal(policy.fixedTrialFeatures(policy.freeTrialFeatures()).TeamInvite.limit_value, 2);
});

function fixture(failTable) {
  let state = { companies: [{ id: 'company' }], users: [{ id: 'admin', company_id: 'company', role: 'admin' }],
    user_plans: [], subscription_plans: [], activity_logs: [] };
  let sequence = 0;
  function connection(draft) {
    return table => {
      const filters = []; let operation, payload, first = false;
      const q = {
        where(value) { filters.push(row => Object.entries(value).every(([key, val]) => row[key] === val)); return q; },
        whereNull(key) { filters.push(row => row[key] == null); return q; },
        forUpdate() { return q; }, first() { first = true; return q; },
        insert(value) { operation = 'insert'; payload = value; return q; },
        update(value) { operation = 'update'; payload = value; return q; }, returning() { return q; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (operation && table === failTable) throw Error('Injected persistence failure');
          let rows = draft[table].filter(row => filters.every(f => f(row)));
          if (operation === 'insert') { rows = [{ id: `${table}-${++sequence}`, ...payload }]; draft[table].push(...rows); }
          if (operation === 'update') rows.forEach(row => Object.assign(row, payload));
          return first ? rows[0] : rows;
        }).then(resolve, reject); },
      };
      return q;
    };
  }
  const db = table => connection(state)(table);
  db.transaction = async callback => { const draft = structuredClone(state); const result = await callback(connection(draft)); state = draft; return result; };
  const { BaseModel } = load('library/surefy/src/models/base.model.ts', { '../database': db });
  const model = load('src/app/models/subscription.model.ts', { '@surefy/models/base.model': { BaseModel } }).default;
  const service = load('src/app/services/subscription.service.ts', { '../models/subscription.model': model,
    './planCatalog.service': { validateFeatures: async features => features } }).default;
  return { state: () => state, db, model, service, BaseModel };
}

test('registration creates an active snapshot, links assigned_plan, starts the chosen duration and charges no wallet', async () => {
  for (const days of [undefined, 3, 7, 10]) {
    const f = fixture();
    const result = await f.model.createFreePlan('admin', 'company', undefined, days);
    const plan = result.user_plan;
    assert.equal(result.active, true); assert.equal(result.trial_days, days ?? 10);
    assert.equal(plan.active, true); assert.equal(plan.status, 'COMPLETED'); assert.equal(plan.entitlement_version, 2);
    assert.equal(f.state().users[0].assigned_plan, plan.id);
    assert.equal(plan.end_date - plan.start_date, (days ?? 10) * 86400000);
    assert.deepEqual(Object.fromEntries(Object.entries(JSON.parse(plan.limits)).map(([key, value]) => [key, value.limit])), expected);
    assert.equal(f.state().activity_logs.length, 1);
    assert.deepEqual(Object.keys(f.state().companies[0]), ['id']);
    await assert.rejects(f.model.createFreePlan('admin', 'company'), /already has/);
  }
});

test('a late activation failure rolls back the definition, snapshot, assignment and registration transaction', async () => {
  const f = fixture('activity_logs'), before = structuredClone(f.state());
  await assert.rejects(f.db.transaction(async trx => {
    await trx('companies').insert({ id: 'new-company' });
    await trx('users').insert({ id: 'new-admin', company_id: 'new-company', role: 'admin' });
    await f.model.createFreePlan('new-admin', 'new-company', trx, 7);
  }), /Injected/);
  assert.deepEqual(f.state(), before);
});

test('Free plan create/update always uses fixed limits; admins can select a duration without extending a running snapshot', async () => {
  const f = fixture();
  const initial = await f.model.createFreePlan('admin', 'company');
  const originalEnd = initial.user_plan.end_date.getTime();
  const actor = { userId: 'admin', companyId: 'company', userRole: 'admin' };
  const updated = await f.service.updateSubscriptionPlan(initial.id, { trial_days: 3 }, actor);
  assert.equal(updated.trial_days, 3);
  assert.equal(f.state().user_plans[0].end_date.getTime(), originalEnd);
  const changed = policy.freeTrialFeatures(); changed.Contact.limit_value = null;
  await assert.rejects(f.service.updateSubscriptionPlan(initial.id, { features: changed }, actor), /fixed by the platform/);
  await assert.rejects(f.service.updateSubscriptionPlan(initial.id, { billing_cycle: 'Monthly' }, actor), /cannot be converted/);
  await assert.rejects(f.service.deleteSubscriptionPlan(initial.id, actor), /cannot be deleted/);
  const data = { plan_name: 'Trial', description: 'Trial', price: 0, active: true, billing_cycle: 'Free' };
  const created = await f.service.createSubscriptionPlan('admin', 'company', 'admin', data);
  assert.equal(created.trial_days, 10);
  assert.equal(JSON.parse(created.features).AiAssistant.limit_value, 1);
  await assert.rejects(f.service.createSubscriptionPlan('admin', 'company', 'admin', { ...data, features: changed }), /fixed by the platform/);
});

test('company registration forwards only duration to the trial initializer, not into company SQL', async () => {
  const f = fixture();
  const company = load('src/app/services/company.service.ts', {
    '@surefy/database': f.db,
    '@surefy/console/repository/company.repository': { create: async (data, trx) => {
      assert.equal(data.trial_days, undefined); assert.equal(data.user, undefined);
      const [row] = await trx('companies').insert(data).returning('*'); return row;
    } },
    '@surefy/middleware/auth.middleware': { generateCompanyKey: () => 'company-key' },
    './auth.service': { register: async (data, trx) => {
      const [row] = await trx('users').insert(data).returning('*'); return row;
    } },
    '../models/subscription.model': f.model,
  }).default;
  const result = await company.onboardCompany({ name: 'Company', email: 'company@example.test', trial_days: 7,
    user: { name: 'Admin', email: 'admin@example.test', password: 'example-password' } });
  assert.equal(result.freePlan.trial_days, 7);
  assert.equal(result.user.assigned_plan, result.freePlan.user_plan.id);
  assert.equal(result.freePlan.user_plan.duration_days, 7);
});

test('registration controller accepts trial_days and never forwards user-supplied limits', async () => {
  let saved;
  const controller = load('src/app/http/controllers/auth.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
    '@surefy/utils/HttpStatusCode': { HttpStatusCode: { CREATED: 201 } },
    '../../services/company.service': { onboardCompany: async data => { saved = data; return data; } },
  }).default;
  const request = { body: { name: 'Company', email: 'company@example.test', trial_days: 3,
    features: { Contact: { limit_value: null } }, user: { name: 'Admin', email: 'admin@example.test', password: 'example-password' } } };
  await controller.onboard(request, {});
  assert.equal(saved.trial_days, 3); assert.equal(saved.features, undefined);
});

test('restricted admin creation activates the same trial atomically and never returns the password', async () => {
  for (const failTable of [undefined, 'activity_logs']) {
    const f = fixture(failTable), before = structuredClone(f.state());
    const userModel = new f.BaseModel('users');
    const auth = load('src/app/services/auth.service.ts', {
      '@surefy/database': f.db,
      '../models/user.model': { findByEmail: async () => null, create: (...args) => userModel.create(...args) },
      '../models/subscription.model': f.model,
    }).default;
    auth.hashPassword = async () => 'hashed-fixture';
    const create = () => auth.createAdminUser({ name: 'New admin', email: 'new@example.test', password: 'example-password',
      role: 'admin', company_id: 'company', trial_days: 7 }, 'superadmin', 'superadmin');
    if (failTable) {
      await assert.rejects(create(), /Injected/); assert.deepEqual(f.state(), before);
    } else {
      const user = await create();
      assert.equal(user.password, undefined); assert.equal(user.freePlan.trial_days, 7);
      assert.equal(user.assigned_plan, user.freePlan.user_plan.id);
      assert.equal(user.freePlan.user_plan.active, true);
    }
  }
});

test('trial policy endpoint exposes locked limits and the allowed duration selector', async () => {
  const controller = load('src/app/http/controllers/planCatalog.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
  }).default;
  const result = await controller.trialPolicy({}, {});
  assert.equal(result.features_locked, true); assert.equal(result.default_trial_days, 10);
  assert.deepEqual(Array.from(result.allowed_trial_days), [3, 7, 10]);
  assert.equal(result.features.Contact.limit_value, 500);
});
