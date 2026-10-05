const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  ts = require('typescript');
class HttpError extends Error {
  constructor({ message }) {
    super(message);
  }
}
function load(file, deps) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText,
    {
      exports,
      require: (name) => {
        assert.ok(name in deps, name);
        return deps[name];
      },
    },
  );
  return exports;
}
const validation = load('src/app/utils/superAdminValidation.ts', {
  uuid: require('uuid'),
  '@surefy/exceptions/HTTP400Error': HttpError,
});
const id = '87af00e3-cdf0-4c59-9950-143dbadf5ebc';
function service(model, companyModel = {}) {
  return load('src/app/services/superAdminOperations.service.ts', {
    '../models/superAdminOperations.model': model,
    '../models/superAdmin.model': companyModel,
    '../utils/superAdminValidation': validation,
  }).default;
}
test('report validation rejects ignored status/search and malformed ticket assignment', () => {
  const s = service({});
  assert.throws(() => s.revenue({ status: 'pending' }, true), /status/);
  assert.throws(() => s.revenue({ forwarded: 'true' }), /Ticket filters/);
  assert.throws(() => s.list('tickets', { assigned_to: 'bad' }), /UUID/);
  assert.throws(() => s.list('tickets', { forwarded: 'yes' }), /boolean|true or false/);
});
test('ticket changes validate target, body and allowed status before writes', () => {
  let calls = 0;
  const s = service({
    changeTicket: () => {
      calls++;
    },
  });
  assert.throws(() => s.changeTicket(id, id, 'forward', { superadmin_id: 'bad', reason: 'Review' }), /UUID/);
  assert.throws(() => s.changeTicket(id, id, 'status', { status: 'deleted', reason: 'Review' }), /status/);
  assert.throws(() => s.changeTicket(id, id, 'reply', { message: '', reason: 'Review' }), /message/);
  assert.equal(calls, 0);
});
test('company escalation cannot forward another company ticket', async () => {
  let changed = false;
  const s = service({
    ticket: async () => ({ company_id: id, user_id: id }),
    changeTicket: () => {
      changed = true;
    },
  });
  await assert.rejects(
    s.escalate(id, 'another-company', 'admin', id, { superadmin_id: id, reason: 'Review' }),
    /accessible/,
  );
  assert.equal(changed, false);
  await s.escalate(id, id, 'user', id, { superadmin_id: id, reason: 'Review' });
  assert.equal(changed, true);
});
test('revenue counts live paid subscriptions and one side of commission ledger', async () => {
  const calls = [];
  const db = (table) => {
    const q = {};
    for (const name of ['where', 'whereNotNull', 'select', 'sum', 'count', 'groupBy'])
      q[name] = (...args) => {
        calls.push([table, name, ...args]);
        return q;
      };
    q.first = () => Promise.resolve({ amount: '100' });
    q.then = (ok, bad) => Promise.resolve([]).then(ok, bad);
    return q;
  };
  db.raw = (sql) => sql;
  class BaseModel {
    constructor() {
      this.db = db;
    }
    query() {
      return db('company_payment_orders');
    }
  }
  const model = load('src/app/models/superAdminOperations.model.ts', {
    '@surefy/models/base.model': { BaseModel },
    '@surefy/exceptions/HTTP404Error': HttpError,
    '@surefy/exceptions/HTTP400Error': HttpError,
  }).default;
  const result = await model.revenue({ page: 1, limit: 25, company_id: id, from: '2026-09-01', to: '2026-10-01' });
  assert.ok(
    calls.some(
      (c) => c[0] === 'company_payment_orders' && c[1] === 'where' && c[2].status === 'paid' && c[2].is_test === false,
    ),
  );
  assert.ok(calls.some((c) => c[1] === 'whereNotNull' && c[2] === 'user_plan_id'));
  assert.ok(
    calls.some(
      (c) =>
        c[0] === 'credit_transactions' &&
        c[1] === 'where' &&
        c[2].type === 'debit' &&
        c[2].reference_type === 'subscription_commission',
    ),
  );
  assert.ok(calls.some((c) => c[1] === 'groupBy' && c[2] === 'currency'));
  assert.ok(calls.some((c) => c[1] === 'where' && c[2] === 'paid_at' && c[3] === '>='));
  assert.equal(result.platform_commission.currency, 'INR');
});

function ticketModel({failAudit=false}={}) {
  let messages=[];
  const db=table=>{
    const query={where(){return query;},whereNull(){return query;},forUpdate(){return query;},
      first:async()=> table==='support_tickets'?{id,company_id:'ticket-company',status:'open',forward_by:'customer',forward_superadmin:'assignee'}:{name:'Actual Admin'},
      insert(data){query.data=data;return query;},
      returning:async()=>{messages.push(query.data);return [{id:'reply-id',...query.data}];},
      then(resolve,reject){return (async()=>{if(table==='superadmin_audit_logs'&&failAudit)throw Error('audit unavailable');return [];})().then(resolve,reject);}
    };return query;
  };
  db.transaction=async fn=>{const old=messages.slice();try{return await fn(db);}catch(error){messages=old;throw error;}};
  class BaseModel{constructor(){this.db=db;}}
  const model=load('src/app/models/superAdminOperations.model.ts',{'@surefy/models/base.model':{BaseModel},'@surefy/exceptions/HTTP404Error':HttpError,'@surefy/exceptions/HTTP400Error':HttpError}).default;
  return {model,messages:()=>messages};
}
test('ticket replies retain ticket company and authenticated sender identity',async()=>{
 const h=ticketModel();await h.model.changeTicket('actual-admin',id,'reply','Investigating','Support response');
 assert.equal(h.messages()[0].company_id,'ticket-company');
 assert.equal(h.messages()[0].user_id,'actual-admin');
 assert.equal(h.messages()[0].forward_superadmin,'assignee');
});
test('failed ticket audit rolls back the reply',async()=>{
 const h=ticketModel({failAudit:true});
 await assert.rejects(h.model.changeTicket('actual-admin',id,'reply','Investigating','Support response'),/audit unavailable/);
 assert.equal(h.messages().length,0);
});
