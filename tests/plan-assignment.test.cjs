const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
class HTTPError extends Error { constructor(data) { super(data.message); } }
function load(path, dependency) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: dependency, Date, console });
  return exports;
}
const duration = load('src/app/utils/subscriptionDuration.ts', () => HTTPError);
function fixture({ existing, failTable, balance = 500, recipientBalance = 20, company = 'c' } = {}) {
  let state = {
    users: [{ id: 'u', company_id: company, name: 'User', assigned_plan: existing?.id },
      { id: 'sa', company_id: 'platform', role: 'superadmin', credit_balance: recipientBalance }],
    companies: [{ id: 'c', company_name: 'Company', credit_balance: balance }],
    subscription_plans: [{ id: 'p', company_id: 'c', active: true, billing_cycle: 'Monthly', price: 500, plan_name: 'Pro', features: {} },
      { id: 'f', company_id: 'c', active: true, billing_cycle: 'Free', trial_days: 7, price: 0, plan_name: 'Trial', features: {} }],
    user_plans: existing ? [existing] : [], credit_transactions: [], activity_logs: [],
  };
  const locks = [];
  let sequence = 0;
  function connection(draft) {
    const trx = table => {
      let filters = [], first = false, operation, payload;
      const q = {
        where: values => { filters.push(row => Object.entries(values).every(([key, val]) => row[key] === val)); return q; },
        whereIn: (key, values) => { filters.push(row => values.includes(row[key])); return q; },
        whereNull: key => { filters.push(row => row[key] == null); return q; },
        orderBy: () => q,
        forUpdate: () => { locks.push(table); return q; }, forShare: () => q,
        first: () => { first = true; return q; },
        update: values => { operation = 'update'; payload = values; return q; },
        insert: values => { operation = 'insert'; payload = values; return q; },
        returning: () => q,
        then: (resolve, reject) => Promise.resolve().then(() => {
          if (operation && table === failTable) throw new Error('Injected database failure');
          let rows = draft[table].filter(row => filters.every(filter => filter(row)));
          if (operation === 'insert') {
            rows = (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: `new-${++sequence}`, ...row }));
            draft[table].push(...rows);
          } else if (operation === 'update') {
            for (const row of rows) for (const [key, value] of Object.entries(payload)) {
              row[key] = value?.raw ? Number(row[key] || 0) + value.delta : value;
            }
          }
          return first ? rows[0] : rows;
        }).then(resolve, reject),
      };
      return q;
    };
    trx.raw = () => { throw new Error('Wallet writes must bind balances compatible with legacy text columns'); };
    return trx;
  }
  const db = { transaction: async callback => {
    const draft = structuredClone(state);
    const result = await callback(connection(draft));
    state = draft;
    return result;
  } };
  const service = load('src/app/services/planAssignment.service.ts', name => {
    if (name === '@surefy/database') return db;
    if (name.includes('activityContext')) return { markActivityRecorded() {} };
    if (name.includes('subscriptionDuration')) return duration;
    if (name.includes('planUsage.service')) return { countTeamSeats: async () => 2 };
    return HTTPError;
  }).default;
  return { service, state: () => state, locks };
}
const actor = { userId: 'admin', userRole: 'admin', companyId: 'c' };
test('assignment links the new user plan and transfers only the platform fee with matching ledger balances', async () => {
  const f = fixture();
  const result = await f.service.updateUser('u', { assigned_plan: 'p', name: 'Updated' }, actor);
  const state = f.state();
  assert.equal(result.user.assigned_plan, result.plan.id);
  assert.equal(result.plan.subscription_id, 'p');
  assert.equal(result.plan.company_id, 'c');
  assert.equal(result.user.plan_name, 'Pro');
  assert.equal(result.user.duration_days, result.plan.duration_days);
  assert.equal(JSON.parse(result.plan.usage).TeamInvite, 2);
  assert.equal(state.companies[0].credit_balance, 400);
  assert.equal(state.users[1].credit_balance, 120);
  const debit = state.credit_transactions[0];
  assert.equal(debit.balance_after - debit.balance_before, debit.amount);
  assert.ok(f.locks.includes('users') && f.locks.includes('companies') && f.locks.includes('user_plans'));
  await assert.rejects(f.service.updateUser('u', { assigned_plan: 'p' }, actor), /already assigned/);
  assert.equal(f.state().credit_transactions.length, 2);
});
test('late failure rolls back wallet debit, history, user changes, and new plan', async () => {
  const f = fixture({ failTable: 'activity_logs' });
  const before = structuredClone(f.state());
  await assert.rejects(f.service.updateUser('u', { assigned_plan: 'p' }, actor), /Injected/);
  assert.deepEqual(f.state(), before);
});
test('insufficient funds and unauthorized requests leave all state unchanged', async () => {
  const f = fixture({ balance: 99 });
  const before = structuredClone(f.state());
  await assert.rejects(f.service.updateUser('u', { assigned_plan: 'p' }, actor), /Insufficient/);
  await assert.rejects(f.service.updateUser('u', { assigned_plan: 'p' }, { ...actor, companyId: 'other' }), /Not authorized/);
  assert.deepEqual(f.state(), before);
});
test('expired same-plan renewal succeeds and retains historical dates', async () => {
  const existing = { id: 'old', user_id: 'u', active: true, subscription_id: 'p', billing_cycle: 'Monthly', end_date: '2020-01-01' };
  const f = fixture({ existing });
  await f.service.updateUser('u', { assigned_plan: 'p' }, actor);
  assert.equal(f.state().user_plans[0].active, false);
  assert.equal(f.state().user_plans[0].end_date, '2020-01-01');
  assert.equal(f.state().user_plans.filter(row => row.active).length, 1);
});
test('Free trial activation lasts seven days, updates assigned_plan, and prevents repeated trials', async () => {
  const f = fixture();
  const result = await f.service.updateUser('u', { assigned_plan: 'f' }, undefined, true);
  assert.equal(result.plan.end_date - result.plan.start_date, 7 * 86400000);
  assert.equal(result.user.assigned_plan, result.plan.id);
  assert.equal(f.state().credit_transactions.length, 0);
  await assert.rejects(f.service.updateUser('u', { assigned_plan: 'f' }, undefined, true));
});
test('an active paid plan cannot be replaced by a Free plan and cross-company plans are rejected', async () => {
  const f = fixture({ existing: { id: 'old', user_id: 'u', active: true, subscription_id: 'old-p', billing_cycle: 'Monthly', end_date: '2099-01-01' } });
  await assert.rejects(f.service.updateUser('u', { assigned_plan: 'f' }, actor), /Cancel the active paid plan/);
  const other = fixture({ company: 'other' });
  await assert.rejects(other.service.updateUser('u', { assigned_plan: 'p' }, { userRole: 'superadmin' }), /another company/);
});

test('legacy text wallet balances and null recipient balance support assignment without SQL arithmetic', async () => {
  for (const recipientBalance of ['20.50', null]) {
    const f = fixture({ balance: '500.75', recipientBalance });
    await f.service.updateUser('u', { assigned_plan: 'p' }, actor);
    assert.equal(f.state().companies[0].credit_balance, 400.75);
    assert.equal(f.state().users[1].credit_balance, Number(recipientBalance ?? 0) + 100);
    assert.equal(f.state().credit_transactions[0].balance_before, 500.75);
  }
});
