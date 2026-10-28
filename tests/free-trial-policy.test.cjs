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
      if (name.endsWith('/subscriptionPlanNames')) return planNames;
      if (name.endsWith('/defaultSubscriptionPlans')) return defaultPlans;
      if (name.endsWith('/defaultPlanAddons')) return addonDefaults;
      return {};
    } });
  return exports;
}
const duration = load('src/app/utils/subscriptionDuration.ts');
const featureUtils = load('src/app/utils/planFeatures.ts');
const policy = load('src/app/utils/freeTrialPolicy.ts');
const planNames = load('src/app/utils/subscriptionPlanNames.ts');
const defaultPlans = load('src/app/utils/defaultSubscriptionPlans.ts');
const addonDefaults = load('src/app/utils/defaultPlanAddons.ts');
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
    user_plans: [], subscription_plans: [], activity_logs: [], plan_addons: [] };
  let sequence = 0;
  function connection(draft) {
    return table => {
      const filters = []; let operation, payload, first = false, conflictKey;
      const q = {
        where(value) { filters.push(row => Object.entries(value).every(([key, val]) => row[key] === val)); return q; },
        whereNull(key) { filters.push(row => row[key] == null); return q; },
        whereIn(key, values) { filters.push(row => values.includes(row[key])); return q; },
        orderBy() { return q; }, onConflict(key) { conflictKey = key; return q; }, ignore() { return q; },
        forUpdate() { return q; }, forNoKeyUpdate() { return q; }, first() { first = true; return q; },
        insert(value) { operation = 'insert'; payload = value; return q; },
        update(value) { operation = 'update'; payload = value; return q; }, returning() { return q; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (operation && (typeof failTable === 'function' ? failTable(table, payload) : table === failTable)) throw Error('Injected persistence failure');
          let rows = draft[table].filter(row => filters.every(f => f(row)));
          if (operation === 'insert') {
            rows = (Array.isArray(payload) ? payload : [payload]).filter(row => !conflictKey || !draft[table].some(saved => saved[conflictKey] === row[conflictKey]))
              .map(row => ({ id: table === 'plan_addons' ? `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` : `${table}-${++sequence}`,
                ...(table === 'plan_addons' ? { active: true } : {}), ...row })); draft[table].push(...rows);
          }
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
    './planCatalog.service': { validateFeatures: async features => features, validatePlanAddons: async input => featureUtils.snapshotPlanAddons(input ?? []) } }).default;
  return { state: () => state, db, model, service, BaseModel };
}

test('registration creates an active snapshot, links assigned_plan, starts the chosen duration and charges no wallet', async () => {
  for (const days of [undefined, 3, 7, 10]) {
    const f = fixture();
    const result = await f.model.createFreePlan('admin', 'company', undefined, days);
    const plan = result.user_plan;
    assert.equal(result.active, true); assert.equal(result.trial_days, days ?? 10);
    assert.equal(result.plan_name, 'Free'); assert.equal(plan.plan_name, 'Free');
    assert.equal(plan.active, true); assert.equal(plan.status, 'COMPLETED'); assert.equal(plan.entitlement_version, 2);
    assert.equal(Object.hasOwn(plan, 'subscription_id'), false);
    assert.equal(f.state().users[0].assigned_plan, plan.id);
    assert.equal(plan.end_date - plan.start_date, (days ?? 10) * 86400000);
    assert.deepEqual(Object.fromEntries(Object.entries(JSON.parse(plan.limits)).map(([key, value]) => [key, value.limit])), expected);
    assert.equal(f.state().activity_logs.length, 1);
    assert.deepEqual(f.state().subscription_plans.map(row => [row.plan_name, row.active, row.price]),
      [['Free', true, 0], ['Basic', false, 99], ['Pro', false, 200], ['Enterprise', false, 999]]);
    assert.equal(f.state().user_plans.length, 1, 'Paid catalog defaults must not create paid assignments');
    assert.equal(result.subscription_plans.length, 4);
    assert.equal(result.addon_catalog.length, 4);
    assert.deepEqual(JSON.parse(result.addons), []);
    for (const row of result.subscription_plans.filter(row => row.billing_cycle === 'Monthly')) {
      assert.equal(JSON.parse(row.addons).length, 4); assert.ok(JSON.parse(row.addons).every(selection => selection.enabled));
    }
    assert.deepEqual(Object.keys(f.state().companies[0]), ['id']);
    await assert.rejects(f.model.createFreePlan('admin', 'company'), /already has/);
  }
});

test('registration seeds the requested paid limits and independent JSON marketing lists under the company owner', async () => {
  const f = fixture();
  await f.model.createFreePlan('admin', 'company', undefined, 3);
  const expectedPaid = {
    Basic: { TeamInvite: 2, Contact: 5000, Campaign: 20, WabaNumber: 1, Chatbot: 2, AiAssistant: 1, developer_api: 0 },
    Pro: { TeamInvite: 2, Contact: 20000, Campaign: null, WabaNumber: 3, Chatbot: 10, AiAssistant: null, developer_api: 1 },
    Enterprise: { TeamInvite: 10, Contact: 100000, Campaign: null, WabaNumber: 10, Chatbot: 50, AiAssistant: null, developer_api: 1 },
  };
  for (const row of f.state().subscription_plans) {
    assert.equal(row.company_id, 'company'); assert.equal(row.user_id, 'admin');
    const features = JSON.parse(row.features), marketing = JSON.parse(row.marketing_features);
    if (row.plan_name === 'Free') {
      assert.equal(marketing[0], '3-day free trial'); assert.equal(row.trial_days, 3); continue;
    }
    assert.equal(row.billing_cycle, 'Monthly'); assert.equal(row.trial_days, null);
    assert.deepEqual(Object.fromEntries(Object.entries(features).map(([key, value]) => [key, value.limit_value])), expectedPaid[row.plan_name]);
    assert.equal(features.Campaign.reset_period, 'monthly'); assert.equal(features.Contact.reset_period, 'never');
    assert.equal(features.developer_api.enabled, row.plan_name !== 'Basic'); assert.ok(marketing.length > 0);
  }
  const altered = defaultPlans.defaultSubscriptionPlans(); altered[1].features.Contact.limit_value = 1;
  altered[1].marketing_features.push('Changed');
  assert.equal(defaultPlans.defaultSubscriptionPlans()[1].features.Contact.limit_value, 5000);
  assert.equal(defaultPlans.defaultSubscriptionPlans()[1].marketing_features.includes('Changed'), false);
});

test('later administrators reuse company paid defaults and preserve existing prices and publication status', async () => {
  const f = fixture(); await f.model.createFreePlan('admin', 'company');
  const basic = f.state().subscription_plans.find(row => row.plan_name === 'Basic');
  const pack = f.state().plan_addons.find(row => row.default_key === 'waba_number');
  await f.db('plan_addons').where({ id: pack.id }).update({ price_paise: 3500, active: false });
  await f.db('subscription_plans').where({ id: basic.id }).update({ price: 149, active: true });
  await f.db('users').insert({ id: 'second-admin', company_id: 'company', role: 'admin' });
  const result = await f.model.createFreePlan('second-admin', 'company');
  const paid = f.state().subscription_plans.filter(row => row.billing_cycle === 'Monthly');
  assert.equal(paid.length, 3); assert.equal(paid.find(row => row.plan_name === 'Basic').price, 149);
  assert.equal(paid.find(row => row.plan_name === 'Basic').active, true);
  assert.equal(result.subscription_plans.find(row => row.plan_name === 'Basic').id, basic.id);
  assert.equal(f.state().plan_addons.length, 4); assert.equal(result.addon_catalog.find(row => row.id === pack.id).price_paise, 3500);
  assert.equal(result.addon_catalog.find(row => row.id === pack.id).active, false);
});

test('a paid default creation failure rolls back company registration, trial, and earlier defaults', async () => {
  const f = fixture((table, data) => table === 'subscription_plans' && data.plan_name === 'Pro');
  const before = structuredClone(f.state());
  await assert.rejects(f.db.transaction(async trx => {
    await trx('companies').insert({ id: 'new-company' });
    await trx('users').insert({ id: 'new-admin', company_id: 'new-company', role: 'admin' });
    await f.model.createFreePlan('new-admin', 'new-company', trx);
  }), /Injected/);
  assert.deepEqual(f.state(), before);
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
  const data = { plan_name: 'Free', description: 'Trial', price: 0, active: true, billing_cycle: 'Free' };
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
  assert.equal(result.freePlan.subscription_plans.length, 4);
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
