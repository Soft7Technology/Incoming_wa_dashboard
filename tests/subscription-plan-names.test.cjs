const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error {
  constructor({ message, details }) { super(message); this.details = details; this.statusCode = 400; }
}
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, console: { log() {}, error() {} }, require: name =>
    deps[name] || (name.includes('/exceptions/') ? HttpError : {}) });
  return exports;
}
const names = load('src/app/utils/subscriptionPlanNames.ts');
const duration = load('src/app/utils/subscriptionDuration.ts');
const features = load('src/app/utils/planFeatures.ts');
const trialPolicy = load('src/app/utils/freeTrialPolicy.ts', { './planFeatures': features, './subscriptionDuration': duration });
const actor = { userId: 'admin', companyId: 'company', userRole: 'admin' };
const body = { plan_name: 'Pro', price: 200, billing_cycle: 'Monthly', description: 'Example', active: true,
  features: { Contact: { limit_value: 20000 } } };
function fixture(existing = body) {
  let saved = { id: 'plan', company_id: 'company', ...existing }, writes = 0;
  const model = {
    findById: async () => saved,
    create: async data => { writes++; saved = { ...saved, ...data }; return saved; },
    update: async (_id, data) => {
      writes++;
      for (const [key, value] of Object.entries(data)) if (value !== undefined) saved[key] = value;
      return saved;
    },
  };
  const service = load('src/app/services/subscription.service.ts', {
    '../utils/subscriptionPlanNames': names, '../utils/subscriptionDuration': duration,
    '../utils/freeTrialPolicy': trialPolicy, '../models/subscription.model': model,
    './planCatalog.service': { validateFeatures: async input => input, validatePlanAddons: async input => input ?? [] },
  }).default;
  return { service, saved: () => saved, writes: () => writes };
}

test('custom and suggested names can be created and used to rename existing plans', async () => {
  for (const plan_name of ['Free', 'Basic', 'Pro', 'Enterprise', 'Starter', 'Free Trial', 'pro', 'PRO', ' Pro ', 'Business Plus 2026', 'व्यवसाय', 'Growth 🚀']) {
    const f = fixture();
    const input = plan_name === 'Free' ? { ...body, plan_name, billing_cycle: 'Free', price: 0, features: undefined } : { ...body, plan_name };
    assert.equal((await f.service.createSubscriptionPlan('admin', 'company', 'admin', input)).plan_name, plan_name);
    assert.equal((await f.service.updateSubscriptionPlan('plan', { plan_name }, actor)).plan_name, plan_name);
  }
});

test('empty, whitespace-only and non-string names fail before any write', async () => {
  for (const plan_name of ['', ' ', '\t\n', null, 1, {}, ['Pro']]) {
    const f = fixture();
    for (const operation of [() => f.service.createSubscriptionPlan('admin', 'company', 'admin', { ...body, plan_name }),
      () => f.service.updateSubscriptionPlan('plan', { plan_name }, actor)]) {
      await assert.rejects(operation(), error => error.statusCode === 400 && error.message === 'plan_name must be a non-empty string');
    }
    assert.equal(f.writes(), 0);
  }
  const f = fixture();
  await assert.rejects(f.service.createSubscriptionPlan('admin', 'company', 'admin', { ...body, plan_name: undefined }), /required/);
  assert.equal(f.writes(), 0);
});

test('existing names remain editable without submitting a name and can be replaced by a custom name', async () => {
  const f = fixture({ ...body, plan_name: 'Legacy Business', features: { Contact: { limit_value: 30000 } } });
  await f.service.updateSubscriptionPlan('plan', { price: 250 }, actor);
  assert.equal(f.saved().plan_name, 'Legacy Business'); assert.equal(f.saved().features.Contact.limit_value, 30000);
  await f.service.updateSubscriptionPlan('plan', { plan_name: 'My Custom Plan' }, actor);
  assert.equal(f.saved().plan_name, 'My Custom Plan'); assert.equal(f.saved().price, 250);
  const trial = fixture({ ...body, plan_name: 'Free Trial', billing_cycle: 'Free', trial_days: 7, price: 0 });
  await trial.service.updateSubscriptionPlan('plan', { trial_days: 10 }, actor);
  assert.equal(trial.saved().plan_name, 'Free Trial'); assert.equal(trial.saved().trial_days, 10);
});

test('plan options allow custom names and return independent suggestions', async () => {
  const controller = load('src/app/http/controllers/planCatalog.controller.ts', {
    '../../utils/subscriptionPlanNames': names,
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
  }).default;
  const options = await controller.planOptions({}, {});
  assert.deepEqual(JSON.parse(JSON.stringify(options)), { plan_names: [
    { label: 'Free', value: 'Free' }, { label: 'Basic', value: 'Basic' },
    { label: 'Pro', value: 'Pro' }, { label: 'Enterprise', value: 'Enterprise' },
  ], custom_names_allowed: true });
  options.plan_names[0].value = 'Custom';
  assert.equal((await controller.planOptions({}, {})).plan_names[0].value, 'Free');
  const route = fs.readFileSync('src/routes/subscription.route.ts', 'utf8');
  assert.match(route, /get\('\/plan-options', planCatalog\.planOptions\)/);
});
