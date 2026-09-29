const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(path, dependencies) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, require: name => dependencies(name), console });
  return exports;
}
class HTTPError extends Error { constructor(data) { super(data.message); } }
const duration = load('src/app/utils/subscriptionDuration.ts', () => HTTPError);
test('Free duration supports 3, 7 and 10 days and defaults legacy plans to 3', () => {
  for (const days of [3, 7, 10]) {
    assert.equal(duration.getPlanDurationDays({ billing_cycle: 'Free', trial_days: days }), days);
  }
  assert.equal(duration.getPlanDurationDays({ billing_cycle: 'Free' }), 3);
  assert.equal(duration.getPlanDurationDays({ billing_cycle: 'Free', trial_days: null }), 3);
  assert.equal(duration.getPlanDurationDays({ billing_cycle: 'Monthly' }), 30);
  assert.equal(duration.getPlanDurationDays({ billing_cycle: 'Yearly' }), 365);
});
test('invalid trial durations and trial durations on paid plans are rejected', () => {
  for (const days of [0, -1, 4, 14, 7.5, '7', null]) {
    assert.throws(() => duration.resolveTrialDays('Free', days), /must be 3, 7, or 10/);
  }
  assert.throws(() => duration.resolveTrialDays('Monthly', 7), /only supported for Free/);
});
test('plan edits preserve duration, accept duration-only updates, and clear it for paid plans', async () => {
  const model = {
    findById: async () => ({ billing_cycle: 'Free', trial_days: 7 }),
    update: async (id, data) => data,
  };
  const service = load('src/app/services/subscription.service.ts', name => {
    if (name.includes('subscriptionDuration')) return duration;
    if (name.includes('subscription.model')) return model;
    if (name.includes('exceptions/')) return HTTPError;
    return {};
  }).default;
  assert.equal((await service.updateSubscriptionPlan('plan', { plan_name: 'Renamed' })).trial_days, 7);
  assert.equal((await service.updateSubscriptionPlan('plan', { trial_days: 10 })).trial_days, 10);
  assert.equal((await service.updateSubscriptionPlan('plan', { billing_cycle: 'Monthly' })).trial_days, null);
  await assert.rejects(service.updateSubscriptionPlan('plan', { trial_days: 5 }), /must be 3, 7, or 10/);
  for (const billing_cycle of ['free', '7days', '', 'Weekly']) {
    await assert.rejects(service.updateSubscriptionPlan('plan', { billing_cycle }), /billing_cycle must be Monthly, Yearly, or Free/);
  }
});

test('calendar periods clamp month ends and leap years and retain precise remaining time', () => {
  const period = duration.calculatePlanPeriod;
  assert.equal(period({ billing_cycle: 'Monthly' }, new Date('2026-01-31T10:00:00Z')).endDate.toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(period({ billing_cycle: 'Yearly' }, new Date('2024-02-29T10:00:00Z')).endDate.toISOString(), '2025-02-28T10:00:00.000Z');
  const start = new Date('2026-09-23T00:00:00Z');
  const old = { active: true, billing_cycle: 'Monthly', end_date: '2026-09-23T12:00:00Z' };
  assert.equal(period({ billing_cycle: 'Monthly' }, start, old).endDate.toISOString(), '2026-10-23T12:00:00.000Z');
  assert.equal(period({ billing_cycle: 'Free', trial_days: 7 }, start, old).endDate.toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(period({ billing_cycle: 'Monthly' }, start, { ...old, billing_cycle: 'Free' }).remainingDays, 0);
  assert.equal(period({ billing_cycle: 'Monthly' }, start, { ...old, end_date: '2026-09-22' }).remainingDays, 0);
});
