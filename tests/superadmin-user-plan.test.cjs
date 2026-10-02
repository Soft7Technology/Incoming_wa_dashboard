const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({ message }) { super(message); } }
function fixture() {
  let state = {
    users: [{ id: 'u', company_id: 'c', assigned_plan: 'p', status: 'active' }],
    user_plans: [{ id: 'p', user_id: 'u', company_id: 'c', status: 'COMPLETED', active: true,
      start_date: new Date(Date.now() - 100000).toISOString(), end_date: new Date(Date.now() + 100000).toISOString(), usage: { Campaign: 3 } }],
    superadmin_audit_logs: [],
  };
  let failAudit = false;
  const connection = draft => {
    const db = table => {
      const filters = []; let operation, payload, first = false;
      const q = {
        where(values) { filters.push(row => Object.entries(values).every(([k,v]) => row[k] === v)); return q; },
        whereNot(values) { filters.push(row => !Object.entries(values).every(([k,v]) => row[k] === v)); return q; },
        whereNull(k) { filters.push(row => row[k] == null); return q; },
        forUpdate() { return q; },
        first() { first = true; return q; },
        update(value) { operation = 'update'; payload = value; return q; },
        insert(value) { operation = 'insert'; payload = value; return q; },
        returning() { return q; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (table === 'superadmin_audit_logs' && failAudit) throw Error('audit failed');
          let rows = draft[table].filter(row => filters.every(f => f(row)));
          if (operation === 'update') rows.forEach(row => Object.assign(row, payload));
          if (operation === 'insert') { rows = [payload]; draft[table].push(payload); }
          return first ? rows[0] : rows;
        }).then(resolve, reject); },
      }; return q;
    }; db.fn = { now: () => 'now' }; return db;
  };
  const db = table => connection(state)(table);
  db.transaction = async fn => { const draft = structuredClone(state); const result = await fn(connection(draft)); state = draft; return result; };
  class BaseModel { constructor() { this.db = db; } query() { return this.db('user_plans'); } }
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/models/superAdminUserPlan.model.ts','utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, Date, require: name => name.includes('base.model') ? { BaseModel } : HttpError });
  return { model: exports.default, state: () => state, failAudit: () => { failAudit = true; } };
}
test('suspend and resume preserve dates and usage, link assigned plan and audit actions', async () => {
  const f = fixture(), before = structuredClone(f.state().user_plans[0]);
  await f.model.changeStatus('sa','c','u','p',false,'Suspend');
  assert.equal(f.state().user_plans[0].active, false);
  await f.model.changeStatus('sa','c','u','p',true,'Resume');
  assert.deepEqual(f.state().user_plans[0], before);
  assert.equal(f.state().users[0].assigned_plan,'p');
  assert.equal(f.state().superadmin_audit_logs.length,2);
});
test('details and status reject cross-company or wrong-user access', async () => {
  const f = fixture();
  await assert.rejects(f.model.details('other','u','p'), /not found/);
  f.state().user_plans[0].user_id = 'other';
  await assert.rejects(f.model.details('c','u','p'), /not found/);
  await assert.rejects(f.model.changeStatus('sa','c','u','p',false,'Suspend'), /not found/);
});
test('activation rejects expired, future, unpaid and conflicting active plans', async () => {
  for (const change of [{ end_date: new Date(0).toISOString() }, { start_date: new Date(Date.now()+1000000).toISOString() }, { status: 'PENDING' }]) {
    const f = fixture(); Object.assign(f.state().user_plans[0], change);
    await assert.rejects(f.model.changeStatus('sa','c','u','p',true,'Resume'), /completed, unexpired/);
  }
  const f = fixture(); f.state().user_plans.push({ id:'other', user_id:'u', active:true });
  await assert.rejects(f.model.changeStatus('sa','c','u','p',true,'Resume'), /current active/);
});
test('audit failure rolls back suspension and activation pointer changes', async () => {
  for (const active of [true,false]) {
    const f = fixture(); f.state().user_plans[0].active = !active;
    f.state().users[0].assigned_plan = null;
    const before = structuredClone(f.state()); f.failAudit();
    await assert.rejects(f.model.changeStatus('sa','c','u','p',active,'Change'), /audit failed/);
    assert.deepEqual(f.state(),before);
  }
});
