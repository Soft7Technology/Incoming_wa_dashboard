const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({ message, details }) { super(message); this.details = details; this.statusCode = 403; } }
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, Date, console, require: name => {
    if (name in deps) return deps[name];
    if (name.includes('/exceptions/')) return HttpError;
    if (name.endsWith('/planFeatures')) return load('src/app/utils/planFeatures.ts');
    return require(name);
  } });
  return exports;
}
const utils = load('src/app/utils/planFeatures.ts');
const usage = load('src/app/services/planUsage.service.ts', { '@surefy/database': {} });
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  let state = {
    users: [{ id: uuid(1), company_id: uuid(3), role: 'user' },
      { id: uuid(2), company_id: uuid(4), role: 'superadmin', credit_balance: '5.00' }],
    companies: [{ id: uuid(3), credit_balance: '1000.00' }],
    user_plans: [{ id: uuid(5), user_id: uuid(1), company_id: uuid(3), active: true, billing_cycle: 'Monthly',
      entitlement_version: 2, start_date: new Date(Date.now() - 86400000), end_date: new Date(Date.now() + 86400000),
      limits: { TeamInvite: { limit: 2, enabled: true, reset_period: 'never' } }, usage: {} }],
    plan_features: [{ key: 'TeamInvite', active: true, addon_allowed: true, kind: 'capacity' },
      { key: 'Campaign', active: true, addon_allowed: true, kind: 'usage' }],
    plan_addons: [{ id: uuid(6), name: 'Extra teammate', feature_key: 'TeamInvite', units: 1, price_paise: 5000, active: true }],
    user_plan_addons: [], credit_transactions: [], activity_logs: [],
    contacts: [], phone_numbers: [], chat_bot: [], ai_assistants: [],
    user_team: [{ invite_sent_by: uuid(1), invite_status: 'sent' }, { invite_sent_by: uuid(1), invite_status: 'accepted' }],
  };
  let failTable, tail = Promise.resolve();
  function connection(draft) {
    const trx = table => {
      const filters = []; let operation, payload, first = false, counting = false;
      const q = {
        where(values) {
          if (typeof values === 'function') {
            const any = [], group = { whereNull(key) { any.push(row => row[key] == null); return group; },
              orWhere(value) { any.push(row => Object.entries(value).every(([k, v]) => row[k] === v)); return group; } };
            values(group); filters.push(row => any.some(matches => matches(row)));
          } else filters.push(row => Object.entries(values).every(([k, v]) => row[k] === v));
          return q;
        },
        whereNull(key) { filters.push(row => row[key] == null); return q; },
        whereIn(key, values) { filters.push(row => values.includes(row[key])); return q; },
        orderBy() { return q; }, select() { return q; }, forUpdate() { return q; }, forShare() { return q; },
        first() { first = true; return q; }, count() { counting = true; return q; },
        update(value) { operation = 'update'; payload = value; return q; },
        insert(value) { operation = 'insert'; payload = value; return q; }, returning() { return q; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (operation && table === failTable) throw Error('Injected database failure');
          let rows = draft[table].filter(row => filters.every(f => f(row)));
          if (operation === 'insert') { rows = (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: uuid(100 + draft[table].length), ...row })); draft[table].push(...rows); }
          if (operation === 'update') rows.forEach(row => {
            const values = { ...payload };
            if (values.usage?.wabaCount !== undefined) values.usage = { ...(typeof row.usage === 'string' ? JSON.parse(row.usage) : row.usage), WabaNumber: values.usage.wabaCount };
            Object.assign(row, values);
          });
          if (counting) rows = [{ total: rows.length }];
          return first ? rows[0] : rows;
        }).then(resolve, reject); },
      };
      return q;
    };
    trx.raw = (_sql, [count]) => ({ wabaCount: count });
    return trx;
  }
  const db = table => connection(state)(table);
  db.transaction = callback => {
    const result = tail.then(async () => { const draft = structuredClone(state); const result = await callback(connection(draft)); state = draft; return result; });
    tail = result.catch(() => {}); return result;
  };
  const catalog = load('src/app/services/planCatalog.service.ts', { '@surefy/database': db });
  const addons = load('src/app/services/planAddon.service.ts', { '@surefy/database': db, './planCatalog.service': catalog });
  const limits = load('src/app/services/planUsage.service.ts', { '@surefy/database': db });
  return { state: () => state, fail: table => { failTable = table; }, addons: addons.default, catalog: catalog.default, limits: limits.default,
    actor: { userId: uuid(7), companyId: uuid(3), userRole: 'admin' },
    body: { user_id: uuid(1), user_plan_id: uuid(5), addon_id: uuid(6), quantity: 3 } };
}

test('feature aliases normalize to stable keys; disabled, zero and unlimited stay distinct', () => {
  const { limits } = utils.snapshotFeatures({ TeamMembers: { limit_value: 2 }, Contact: { limit_value: 0 }, Campaign: { limit_value: null }, Chatbot: { enabled: false, limit_value: null } });
  assert.equal(limits.TeamInvite.limit, 2); assert.equal(limits.Contact.limit, 0);
  assert.equal(limits.Campaign.limit, null); assert.equal(limits.Chatbot.enabled, false);
  for (const input of [{ Contact: { limit_value: -1 } }, { Contact: {} }, { Contact: { limit_value: '20' } }, { Contact: { limit_value: 1.5 } }, { Contact: { limit_value: 1, enabled: 'false' } }, { TeamMembers: { limit_value: 2 }, TeamInvite: { limit_value: 2 } }]) assert.throws(() => utils.normalizeFeatures(input));
});

test('unlimited resources are omitted from new snapshots, feature catalogs and add-ons', async () => {
  const f = fixture();
  const features = { Contact: { limit_value: 500 }, Tag: { limit_value: 0, enabled: false },
    messages: { limit_value: 1 }, custom_columns: { limit_value: 2 } };
  const saved = utils.snapshotFeatures(features);
  assert.deepEqual(Object.keys(saved.limits), ['Contact']);
  assert.deepEqual(Object.keys(saved.usage), ['Contact']);
  for (const key of ['Tag', 'Message', 'CustomColumn']) {
    f.state().plan_features.push({ key, active: true, addon_allowed: true, kind: 'usage' });
    f.state().plan_addons.push({ id: uuid(300 + f.state().plan_addons.length), feature_key: key, active: true });
  }
  assert.deepEqual(Array.from(await f.catalog.features(), row => row.key), ['TeamInvite', 'Campaign']);
  assert.equal((await f.catalog.addons(true)).length, 1);
  const superadmin = { userId: uuid(2), userRole: 'superadmin' };
  await assert.rejects(f.catalog.createFeature(superadmin, { key: 'Tags', label: 'Tags', kind: 'usage' }), /reserved/);
  await assert.rejects(f.catalog.createAddon(superadmin, { feature_key: 'Message' }), /unlimited/);
  const addon = f.state().plan_addons[1];
  await assert.rejects(f.catalog.validatePlanAddons([{ addon_id: addon.id, enabled: false }], features, 'Monthly'), /unlimited/);
  await assert.rejects(f.catalog.updateAddon(superadmin, addon.id, { active: true }), /unlimited/);
  f.state().user_plans[0].limits = { Tag: { enabled: true, limit: 1 } };
  f.state().user_plans[0].addons = null;
  await assert.rejects(f.addons.purchase(f.actor, { ...f.body, addon_id: addon.id }, 'unmetered-purchase'), /unlimited/);
  assert.equal(f.state().user_plan_addons.length, 0);
  assert.equal(f.state().companies[0].credit_balance, '1000.00');
});

test('entitlement summary omits historical unlimited resources while keeping metered features', async () => {
  const f = fixture();
  Object.assign(f.state().user_plans[0].limits, { Tag: { limit: 0 }, Message: { limit: 10 }, Column: { limit: null } });
  assert.deepEqual(Object.keys((await f.limits.summary(uuid(1))).features), ['TeamInvite']);
});

test('new plans deny omitted/disabled features and add-ons increase only the purchased finite limit', () => {
  const f = fixture(), plan = f.state().user_plans[0];
  assert.throws(() => usage.checkUsage(plan, 'Contact'), /not included/);
  assert.equal(usage.checkUsage({ ...plan, limits: { TeamInvite: { limit: 2, addon_limit: 3 } } }, 'TeamMembers').limit, 5);
  assert.throws(() => usage.checkUsage({ ...plan, limits: { TeamInvite: { limit: 2, enabled: false } } }, 'TeamInvite'), /not included/);
});

test('saved integer-string add-on capacity is numeric; malformed values never grant capacity', async () => {
  const f = fixture(), plan = f.state().user_plans[0];
  plan.limits.WabaNumber = { limit: 3, addon_limit: '2', enabled: true };
  assert.equal(usage.checkUsage(plan, 'WabaNumber', 5).limit, 5);
  assert.throws(() => usage.checkUsage(plan, 'WabaNumber', 6), /limit reached/);
  const summary = (await f.limits.summary(uuid(1))).features.WabaNumber;
  assert.equal(summary.addon_limit, 2); assert.equal(summary.effective_limit, 5); assert.equal(summary.remaining, 5);
  for (const value of ['', ' ', '2.5', '-1', 'Infinity', '1e3', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => usage.checkUsage({ ...plan, limits: { WabaNumber: { limit: 3, addon_limit: value } } }, 'WabaNumber', 0), /Invalid WabaNumber add-on/);
  }
  let slots;
  await f.limits.syncWabaNumbers(uuid(1), async (_trx, capacity) => { slots = capacity.remaining; });
  assert.equal(slots, 5);
});

test('purchasing an add-on normalizes a legacy numeric-string bonus without losing previous units', async () => {
  const f = fixture();
  f.state().user_plans[0].limits.TeamInvite.addon_limit = '2';
  await f.addons.purchase(f.actor, f.body, 'legacy-bonus');
  assert.equal(JSON.parse(f.state().user_plans[0].limits).TeamInvite.addon_limit, 5);
});

test('monthly/yearly usage resets on anniversary boundaries, preserving input and capacity counters', () => {
  const plan = { active: true, start_date: '2024-01-31T12:00:00Z', end_date: '2030-01-01',
    limits: { Campaign: { limit: 10, reset_period: 'monthly' }, TeamInvite: { limit: 2, reset_period: 'never' } }, usage: { Campaign: 10, TeamInvite: 2 } };
  assert.throws(() => usage.checkUsage(plan, 'Campaign', 1, new Date('2024-02-29T11:59:59Z')), /limit reached/);
  const result = usage.checkUsage(plan, 'Campaign', 1, new Date('2024-02-29T12:00:00Z'));
  assert.equal(result.used, 0); assert.equal(plan.usage.Campaign, 10);
  assert.throws(() => usage.checkUsage(plan, 'TeamInvite', 1, new Date('2024-03-31T12:00:00Z')), /limit reached/);
  assert.equal(utils.usagePeriodStart(new Date('2024-02-29T12:00:00Z'), new Date('2025-02-28T12:00:00Z'), 'yearly'), '2025-02-28T12:00:00.000Z');
  assert.equal(utils.usagePeriodStart(new Date(plan.start_date), new Date('2024-03-31T12:00:00Z'), 'monthly'), '2024-03-31T12:00:00.000Z');
});

test('catalog makes usage follow billing and prevents capacity resets', async () => {
  const f = fixture();
  const features = { Campaign: { limit_value: null }, TeamMembers: { limit_value: 2 } };
  assert.equal((await f.catalog.validateFeatures(features, 'Yearly')).Campaign.reset_period, 'yearly');
  assert.equal((await f.catalog.validateFeatures(features, 'Monthly')).Campaign.reset_period, 'monthly');
  assert.equal((await f.catalog.validateFeatures(features, 'Monthly')).TeamInvite.reset_period, 'never');
  await assert.rejects(f.catalog.validateFeatures({ TeamInvite: { limit_value: 2, reset_period: 'monthly' } }, 'Monthly'), /capacity/);
  await assert.rejects(f.catalog.validateFeatures({ FutureFeature: { limit_value: 1 } }), /register it first/);
  await assert.rejects(f.catalog.createAddon(f.actor, {}), /Only superadmin/);
});

test('plan add-on selections reject client prices, duplicate IDs and malformed toggles', () => {
  for (const input of [{}, [null], [{ addon_id: uuid(6), enabled: 'true' }],
    [{ addon_id: uuid(6), enabled: true, price_paise: 1 }], [{ addon_id: uuid(6), enabled: true, units: 999 }],
    [{ addon_id: uuid(6), enabled: true }, { addon_id: uuid(6).toUpperCase(), enabled: false }]]) {
    assert.throws(() => utils.snapshotPlanAddons(input));
  }
  assert.equal(utils.snapshotPlanAddons(null), null);
  assert.equal(utils.snapshotPlanAddons([]).length, 0);
});

test('plan validation enables only available finite paid features and preserves disabled selections', async () => {
  const f = fixture(), selection = [{ addon_id: uuid(6), enabled: true }], finite = { TeamInvite: { limit_value: 2 } };
  assert.equal((await f.catalog.validatePlanAddons(selection, finite, 'Monthly'))[0].enabled, true);
  for (const [features, cycle] of [[finite, 'Free'], [{}, 'Monthly'],
    [{ TeamInvite: { limit_value: null } }, 'Monthly'], [{ TeamInvite: { limit_value: 2, enabled: false } }, 'Monthly']]) {
    await assert.rejects(f.catalog.validatePlanAddons(selection, features, cycle), /Cannot enable/);
  }
  await assert.rejects(f.catalog.validatePlanAddons([{ addon_id: uuid(99), enabled: false }], finite, 'Monthly'), /does not exist/);
  for (const input of [null, '[]', {}]) await assert.rejects(f.catalog.validatePlanAddons(input, finite, 'Monthly'), /array/);
  f.state().plan_addons[0].active = false;
  await assert.rejects(f.catalog.validatePlanAddons(selection, finite, 'Monthly'), /Cannot enable/);
  assert.equal((await f.catalog.validatePlanAddons([{ addon_id: uuid(6), enabled: false }], {}, 'Free'))[0].enabled, false);
  assert.equal(f.state().companies[0].credit_balance, '1000.00'); assert.equal(f.state().user_plan_addons.length, 0);
});

test('plan add-on display returns stored switches and rejects foreign company plans', async () => {
  const f = fixture();
  f.state().subscription_plans = [{ id: uuid(40), company_id: uuid(3), billing_cycle: 'Monthly',
    features: { TeamInvite: { limit_value: 2 } }, addons: [{ addon_id: uuid(6), enabled: true }] },
    { id: uuid(41), company_id: uuid(99), billing_cycle: 'Monthly', features: {}, addons: [] }];
  assert.equal((await f.catalog.planAddons(f.actor))[0].enabled, false);
  assert.equal((await f.catalog.planAddons(f.actor, uuid(40)))[0].enabled, true);
  await assert.rejects(f.catalog.planAddons(f.actor, uuid(41)), /not found in your company/);
  f.state().subscription_plans[0].addons = [];
  assert.equal((await f.catalog.planAddons(f.actor, uuid(40)))[0].enabled, false);
  await assert.rejects(f.catalog.planAddons(f.actor, 'not-a-uuid'), /UUID/);
});

test('disabled or unselected assigned add-ons cannot debit wallets; enabled selections can be purchased', async () => {
  for (const addons of [[], [{ addon_id: uuid(6), enabled: false }], [{ addon_id: uuid(99), enabled: true }]]) {
    const f = fixture(); f.state().user_plans[0].addons = addons;
    await assert.rejects(f.addons.purchase(f.actor, f.body, 'blocked'), /not enabled/);
    assert.equal(f.state().companies[0].credit_balance, '1000.00'); assert.equal(f.state().user_plan_addons.length, 0);
    assert.equal(f.state().credit_transactions.length, 0);
  }
  const f = fixture(); f.state().user_plans[0].addons = JSON.stringify([{ addon_id: uuid(6), enabled: true }]);
  const purchase = await f.addons.purchase(f.actor, f.body, 'enabled'); assert.equal(purchase.units, 3);
  f.state().user_plans[0].addons = [];
  assert.equal((await f.addons.purchase(f.actor, f.body, 'enabled')).id, purchase.id, 'Retry keeps the historical receipt');
  await assert.rejects(f.addons.purchase(f.actor, f.body, 'new-purchase'), /not enabled/);
  assert.equal(f.state().user_plan_addons.length, 1);
});

test('wallet purchase increases 2 seats to 5, transfers money with matching ledger and expires with plan', async () => {
  const f = fixture();
  const p = await f.addons.purchase(f.actor, f.body, 'first');
  assert.equal(f.state().companies[0].credit_balance, 850);
  assert.equal(f.state().users[1].credit_balance, 155);
  assert.equal(p.units, 3); assert.equal(p.amount_paise, 15000);
  assert.equal(new Date(p.expires_at).getTime(), f.state().user_plans[0].end_date.getTime());
  assert.equal(JSON.parse(f.state().user_plans[0].limits).TeamInvite.addon_limit, 3);
  assert.equal(f.state().credit_transactions.length, 2);
  assert.equal(f.state().credit_transactions.reduce((sum, t) => sum + t.amount, 0), 0);
  const summary = await f.limits.summary(uuid(1));
  assert.equal(summary.features.TeamInvite.effective_limit, 5);
  assert.equal(summary.features.TeamInvite.used, 2); assert.equal(summary.features.TeamInvite.remaining, 3);
});

test('concurrent duplicate purchases debit once; retries preserve purchased price after expiry', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.addons.purchase(f.actor, f.body, 'same'), f.addons.purchase(f.actor, f.body, 'same')]);
  assert.equal(a.id, b.id); assert.equal(f.state().user_plan_addons.length, 1);
  f.state().user_plans[0].active = false; f.state().plan_addons[0].price_paise = 9999;
  assert.equal((await f.addons.purchase(f.actor, f.body, 'same')).amount_paise, 15000);
  assert.equal(f.state().companies[0].credit_balance, 850);
  await assert.rejects(f.addons.purchase(f.actor, { ...f.body, quantity: 2 }, 'same'), /different add-on purchase/);
});

test('insufficient balance, unavailable entitlement, stale plan and foreign tenant cannot charge', async () => {
  for (const mutate of [
    f => { f.state().companies[0].credit_balance = '149.99'; },
    f => { f.state().user_plans[0].limits.TeamInvite.limit = null; },
    f => { f.state().user_plans[0].limits.TeamInvite.enabled = false; },
    f => { f.state().user_plans[0].active = false; },
    f => { f.state().user_plans[0].end_date = new Date(0); },
    f => { f.state().user_plans[0].billing_cycle = 'Free'; },
    f => { f.state().users[0].company_id = uuid(99); },
    f => { f.state().plan_addons[0].active = false; },
  ]) {
    const f = fixture(); mutate(f); const before = structuredClone(f.state());
    await assert.rejects(f.addons.purchase(f.actor, f.body, 'invalid'));
    assert.deepEqual(f.state(), before);
  }
});

test('tampered prices, missing idempotency, bad quantities and non-admin actors fail before charging', async () => {
  const f = fixture();
  for (const body of [{ ...f.body, amount_paise: 1 }, { ...f.body, quantity: 0 }, { ...f.body, quantity: 1.5 }, { ...f.body, quantity: '3' }]) await assert.rejects(f.addons.purchase(f.actor, body, 'tamper'));
  await assert.rejects(f.addons.purchase(f.actor, f.body, undefined), /Idempotency/);
  await assert.rejects(f.addons.purchase({ ...f.actor, userRole: 'user' }, f.body, 'unauthorized'), /administrator/);
  assert.equal(f.state().credit_transactions.length, 0);
});

test('ledger or audit failure rolls back both wallets, purchase and capacity', async () => {
  for (const table of ['credit_transactions', 'activity_logs']) {
    const f = fixture(), before = structuredClone(f.state()); f.fail(table);
    await assert.rejects(f.addons.purchase(f.actor, f.body, 'rollback'), /Injected/);
    assert.deepEqual(f.state(), before);
  }
});

test('newly assigned plans count existing seats and capacity deletion frees a seat', async () => {
  const f = fixture();
  await assert.rejects(f.limits.run(uuid(1), 'TeamInvite', async () => 'created'), /limit reached/);
  f.state().user_team.pop();
  await f.limits.run(uuid(1), 'TeamInvite', trx => trx('user_team').insert({ invite_sent_by: uuid(1), invite_status: 'sent' }));
  assert.equal(f.state().user_team.length, 2);
});

test('stored capacity survives renewal counters and excludes deleted contacts and phone numbers', async () => {
  for (const [key, table, softDelete] of [['Contact', 'contacts', true], ['WabaNumber', 'phone_numbers', true], ['Chatbot', 'chat_bot', false], ['AiAssistant', 'ai_assistants', false]]) {
    const f = fixture();
    f.state().user_plans[0].limits[key] = { limit: 1, enabled: true, reset_period: 'never' };
    f.state()[table].push({ user_id: uuid(1), ...(key === 'WabaNumber' ? { active: true } : {}) });
    let called = false;
    await assert.rejects(f.limits.run(uuid(1), key, async () => { called = true; }), /limit reached/);
    assert.equal(called, false);
    if (softDelete) f.state()[table][0].deleted_at = new Date(); else f.state()[table].pop();
    await f.limits.run(uuid(1), key, trx => trx(table).insert({ user_id: uuid(1), ...(key === 'WabaNumber' ? { active: true } : {}) }));
    assert.equal(JSON.parse(f.state().user_plans[0].usage)[key], 1);
  }
});

test('consuming a reset quota persists its period and cannot reset repeatedly', async () => {
  const f = fixture();
  f.state().user_plans[0].start_date = new Date('2020-01-01');
  f.state().user_plans[0].limits.Campaign = { limit: 1, enabled: true, reset_period: 'monthly' };
  f.state().user_plans[0].usage = { Campaign: 1 };
  await f.limits.run(uuid(1), 'Campaign', async () => 'created');
  assert.equal(JSON.parse(f.state().user_plans[0].usage).Campaign, 1);
  assert.ok(JSON.parse(f.state().user_plans[0].usage_periods).Campaign);
  await assert.rejects(f.limits.run(uuid(1), 'Campaign', async () => 'again'), /limit reached/);
});

test('concurrent WABA allocations share the last slot without inserting overflow', async () => {
  const f = fixture();
  f.state().user_plans[0].limits.WabaNumber = { limit: 1, enabled: true, reset_period: 'never' };
  await Promise.all(['one', 'two'].map(id => f.limits.syncWabaNumbers(uuid(1), async (trx, capacity) => {
    if (capacity.remaining <= 0) return [];
    return trx('phone_numbers').insert({ id, user_id: uuid(1), active: capacity.remaining > 0 });
  })));
  assert.equal(f.state().phone_numbers.length, 1);
  assert.equal(f.state().phone_numbers.filter(phone => phone.active).length, 1);
  assert.equal(f.state().user_plans[0].usage.WabaNumber, 1);
  await assert.rejects(f.limits.run(uuid(1), 'WabaNumber', async () => {}), /limit reached/);
});

test('WABA allocation reconciles a downgrade and prevents new inventory without a usable slot', async () => {
  for (const state of ['downgrade', 'disabled', 'expired', 'absent', 'unlimited']) {
    const f = fixture(), plan = f.state().user_plans[0];
    plan.limits.WabaNumber = { limit: state === 'unlimited' ? null : 2, enabled: state !== 'disabled' };
    if (state === 'expired') plan.end_date = new Date(0);
    if (state === 'absent') f.state().user_plans = [];
    for (let i = 0; i < 3; i++) f.state().phone_numbers.push({ id: uuid(20 + i), user_id: uuid(1), active: true });
    await f.limits.syncWabaNumbers(uuid(1), (trx, capacity) => capacity.remaining <= 0 ? Promise.resolve([]) : trx('phone_numbers').insert({
      id: uuid(24), user_id: uuid(1), active: capacity.remaining > 0,
      inactive_reason: capacity.remaining > 0 ? null : capacity.inactiveReason,
    }));
    const expected = state === 'unlimited' ? 4 : state === 'downgrade' ? 2 : 0;
    assert.equal(f.state().phone_numbers.length, state === 'unlimited' ? 4 : 3);
    assert.equal(f.state().phone_numbers.filter(phone => phone.active).length, expected, state);
    if (state !== 'absent') assert.equal(f.state().user_plans[0].usage.WabaNumber, expected);
  }
});

test('a failed sync rolls back any downgrade deactivation as well as new inventory', async () => {
  const f = fixture(); f.state().user_plans[0].limits.WabaNumber = { limit: 0 };
  f.state().phone_numbers.push({ id: uuid(20), user_id: uuid(1), active: true });
  const before = structuredClone(f.state());
  await assert.rejects(f.limits.syncWabaNumbers(uuid(1), async () => { throw Error('Meta inventory write failed'); }), /inventory write failed/);
  assert.deepEqual(f.state(), before);
});

test('downgraded accounts can read their over-capacity usage and refresh without adding resources', async () => {
  const f = fixture();
  f.state().user_plans[0].limits.TeamInvite.limit = 1;
  assert.equal((await f.limits.summary(uuid(1))).features.TeamInvite.remaining, 0);
  await f.limits.run(uuid(1), 'TeamInvite', async () => 'refreshed', 0);
  await assert.rejects(f.limits.run(uuid(1), 'TeamInvite', async () => 'new'), /limit reached/);
});

test('assistant creation enforces the owner quota and writes through the same transaction', async () => {
  const f = fixture();
  f.state().user_plans[0].limits.AiAssistant = { limit: 0, enabled: true, reset_period: 'never' };
  let calls = 0;
  const controller = load('src/app/http/controllers/aiAssistant.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
    '../../models/aiAssistant.model': { create: async (data, trx) => {
      calls++; assert.equal(typeof trx, 'function'); assert.equal(data.user_id, uuid(1));
      await trx('ai_assistants').insert(data); return data;
    } },
    '../../utils/crypto.util': { encryptApiKey: () => 'encrypted' },
    '../../services/aiAssistant.service': { testProviderConnection: async () => ({ success: true }) },
    '../../services/planUsage.service': f.limits,
  }).default;
  const req = { userId: uuid(8), ownerId: uuid(1), body: { name: 'Helper', role: 'Support', promptType: 'custom', customPrompt: 'Help', provider: 'example', model: 'example', apiKey: 'example' } };
  await assert.rejects(controller.createAssistant(req, {}), /limit reached/);
  assert.equal(calls, 0);
  f.state().user_plans[0].limits.AiAssistant.limit = 1;
  await controller.createAssistant(req, {});
  assert.equal(calls, 1); assert.equal(f.state().ai_assistants.length, 1);
});
