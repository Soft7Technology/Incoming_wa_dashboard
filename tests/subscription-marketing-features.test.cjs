const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, console: { log() {}, error() {} }, require: name => deps[name] || (name.includes('/exceptions/') ? HttpError : {}) });
  return exports;
}
function fixture() {
  let state = { id: 'plan', company_id: 'company', billing_cycle: 'Monthly', price: 200,
    marketing_features: ['Existing support'], features: { Contact: { limit_value: 20000 } } };
  const model = {
    findById: async () => state,
    create: async data => (state = { ...data, id: 'plan' }),
    update: async (_id, data) => {
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        if (key === 'marketing_features' || key === 'addons') {
          assert.equal(typeof value, 'string', 'JSONB updates must be serialized instead of sent as SQL arrays');
          state[key] = JSON.parse(value);
        } else state[key] = value;
      }
      return state;
    },
  };
  const service = load('src/app/services/subscription.service.ts', {
    '../models/subscription.model': model,
    '../utils/subscriptionDuration': load('src/app/utils/subscriptionDuration.ts'),
    '../utils/subscriptionPlanNames': load('src/app/utils/subscriptionPlanNames.ts'),
    './planCatalog.service': { validateFeatures: async input => input, validatePlanAddons: async input => input ?? [] },
  }).default;
  return { service, state: () => state };
}
const body = { plan_name: 'Pro', price: 200, billing_cycle: 'Monthly', description: 'Pro plan', active: true,
  features: { Contact: { limit_value: 20000 } } };
test('create saves optional display text without increasing feature limits', async () => {
  const f = fixture();
  const result = await f.service.createSubscriptionPlan('admin', 'company', 'admin', {
    ...body, marketing_features: [' 24/7 Customer Support ', 'Unlimited exports'],
  });
  assert.deepEqual(Array.from(result.marketing_features), ['24/7 Customer Support', 'Unlimited exports']);
  assert.equal(result.features.Contact.limit_value, 20000);
  assert.equal(Object.keys(result.features).length, 1);
  const empty = await f.service.createSubscriptionPlan('admin', 'company', 'admin', body);
  assert.equal(empty.marketing_features.length, 0);
});
test('partial updates preserve omitted marketing text; explicit empty list clears it', async () => {
  const f = fixture();
  await f.service.updateSubscriptionPlan('plan', { description: 'Updated description' });
  assert.deepEqual(f.state().marketing_features, ['Existing support']);
  await f.service.updateSubscriptionPlan('plan', { marketing_features: [' Priority onboarding '] });
  assert.deepEqual(f.state().marketing_features, ['Priority onboarding']);
  await f.service.updateSubscriptionPlan('plan', { marketing_features: [] });
  assert.deepEqual(f.state().marketing_features, []);
  assert.equal(f.state().features.Contact.limit_value, 20000);
});

test('plan add-on switches persist on create/update, omission preserves them, and [] clears them', async () => {
  const f = fixture(), selected = [{ addon_id: '00000000-0000-4000-8000-000000000006', enabled: true }];
  await f.service.createSubscriptionPlan('admin', 'company', 'admin', { ...body, addons: selected });
  assert.deepEqual(f.state().addons, selected);
  await f.service.updateSubscriptionPlan('plan', { description: 'Keep existing selections' });
  assert.deepEqual(f.state().addons, selected);
  await f.service.updateSubscriptionPlan('plan', { addons: [{ ...selected[0], enabled: false }] });
  assert.equal(f.state().addons[0].enabled, false);
  await f.service.updateSubscriptionPlan('plan', { addons: [] });
  assert.equal(f.state().addons.length, 0);
});
test('invalid marketing lists fail before saving a plan', async () => {
  for (const value of [null, 'Support', {}, [1], [''], ['  '], ['a'.repeat(251)], Array(101).fill('Support')]) {
    const f = fixture();
    await assert.rejects(f.service.createSubscriptionPlan('admin', 'company', 'admin', { ...body, marketing_features: value }), /marketing_features/);
    await assert.rejects(f.service.updateSubscriptionPlan('plan', { marketing_features: value }), /marketing_features/);
    assert.deepEqual(f.state().marketing_features, ['Existing support']);
  }
});
test('create/update controllers forward the screenshot text list to the service', async () => {
  const calls = [];
  const controller = load('src/app/http/controllers/subscription.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
    '@surefy/utils/HttpStatusCode': { HttpStatusCode: { CREATED: 201, OK: 200 } },
    '../../services/subscription.service': {
      createSubscriptionPlan: async (...args) => { calls.push(args[3]); return { id: 'plan', ...args[3] }; },
      updateSubscriptionPlan: async (_id, data) => { calls.push(data); return { id: 'plan', ...data }; },
    },
    '../../models/activityLogs.model': { create: async () => {} },
  }).default;
  const req = { userId: 'admin', userRole: 'admin', companyId: 'company', params: { id: 'plan' },
    body: { ...body, marketing_features: ['24/7 Customer Support'], addons: [{ addon_id: '00000000-0000-4000-8000-000000000006', enabled: false }] }, headers: {}, socket: {} };
  await controller.createSubscription(req, {});
  await controller.updateSubscriptionPlan(req, {});
  assert.equal(calls.length, 2);
  for (const data of calls) assert.deepEqual(data.marketing_features, ['24/7 Customer Support']);
  for (const data of calls) assert.deepEqual(data.addons, req.body.addons);
});
