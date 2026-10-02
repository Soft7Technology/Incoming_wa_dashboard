const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  vm = require('node:vm'),
  ts = require('typescript');
const knex = require('knex');
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
      Buffer,
      process: { env: { JWT_SECRET: 'test-secret' } },
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
function service(model) {
  return load('src/app/services/superAdmin.service.ts', {
    bcrypt: { hash: async () => 'hashed' },
    '../models/superAdmin.model': model,
    '../utils/superAdminValidation': validation,
    '@surefy/exceptions/HTTP403Error': HttpError,
    '@surefy/exceptions/HTTP400Error': HttpError,
  }).default;
}
test('filters reject unsafe pagination, unknown query keys and bad UUIDs', () => {
  assert.equal(validation.filters({ page: '2', limit: '50' }).page, 2);
  for (const input of [
    { limit: '101' },
    { page: ['1'] },
    { company_id: 'bad' },
    { sort: 'password' },
    { from: '2026-10-01', to: '2026-09-01' },
  ])
    assert.throws(() => validation.filters(input));
});
test('credit amounts enforce fixed precision and bounded positive values', () => {
  assert.equal(validation.creditAmount('10.25'), '10.25');
  assert.equal(validation.creditAmount(10), '10.00');
  for (const value of [0, -1, '1.234', '1e3', 'NaN', Infinity, '10000000000000'])
    assert.throws(() => validation.creditAmount(value));
});
test('authorization requires a live active database superadmin', async () => {
  await assert.rejects(service({ activeAdministrator: async () => null }).authorize(id), /superadmin/);
  await assert.rejects(service({}).authorize(undefined), /superadmin/);
  await service({ activeAdministrator: async () => ({ id }) }).authorize(id);
});
test('company creation allowlists fields and hashes the initial password', async () => {
  let saved;
  const s = service({
    createCompany: async (...args) => {
      saved = args;
      return {};
    },
  });
  const body = {
    name: 'Example',
    email: 'OWNER@example.com',
    user: { name: 'Admin', email: 'admin@example.com', password: 'long-password-123' },
    reason: 'Onboarding',
  };
  await s.createCompany(id, body);
  assert.equal(saved[1].email, 'owner@example.com');
  assert.equal(saved[2].password, 'hashed');
  await assert.rejects(s.createCompany(id, { ...body, credit_balance: 999 }), /Unsupported/);
  await assert.rejects(s.createCompany(id, { ...body, user: { ...body.user, role: 'superadmin' } }), /Unsupported/);
});
test('nested company collection overrides a conflicting query scope', async () => {
  let f;
  const s = service({
    company: async () => ({ id }),
    collection: async (resource, filters) => {
      f = filters;
    },
  });
  await s.collection('users', { company_id: 'ae815512-cf4b-4e7e-8472-16d3c2d4bb18' }, id);
  assert.equal(f.company_id, id);
});
test('status and profile updates cannot change role, password or wallet balance', () => {
  const s = service({});
  assert.throws(() => s.updateCompany(id, id, { credit_balance: 100, reason: 'bad' }), /Unsupported/);
  assert.throws(() => s.updateUser(id, id, id, { role: 'superadmin', reason: 'bad' }), /Unsupported/);
  assert.throws(() => s.companyStatus(id, id, { status: 'unknown', reason: 'bad' }), /status/);
});
function modelHarness({ auditFails = false } = {}) {
  let balance = '10.00',
    entries = [],
    audits = [];
  const builder = (table) => {
    let values,
      operation,
      where = {};
    const q = {
      where(data) {
        Object.assign(where, data);
        return q;
      },
      whereNull() {
        return q;
      },
      forUpdate() {
        return q;
      },
      first: async () =>
        table === 'companies'
          ? { id, credit_balance: balance }
          : entries.find((e) => e.reference_id === where.reference_id),
      update(data) {
        operation = 'update';
        values = data;
        return q;
      },
      insert(data) {
        operation = 'insert';
        values = data;
        return q;
      },
      returning: async () => {
        if (table === 'companies') {
          balance = (Number(balance) + Number(values.credit_balance.amount)).toFixed(2);
          return [{ credit_balance: balance }];
        }
        const entry = { id: 'entry', ...values };
        entries.push(entry);
        return [entry];
      },
      then(resolve, reject) {
        return (async () => {
          if (table === 'superadmin_audit_logs') {
            if (auditFails) throw Error('audit failed');
            audits.push(values);
          }
          return [];
        })().then(resolve, reject);
      },
    };
    return q;
  };
  builder.fn = { now: () => new Date() };
  builder.raw = (sql, args) => ({ amount: args[0] });
  builder.transaction = async (fn) => {
    const old = [balance, entries.slice(), audits.slice()];
    try {
      return await fn(builder);
    } catch (e) {
      [balance, entries, audits] = old;
      throw e;
    }
  };
  class BaseModel {
    constructor() {
      this.db = builder;
    }
  }
  const model = load('src/app/models/superAdmin.model.ts', {
    '@surefy/models/base.model': { BaseModel },
    '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError,
    './subscription.model': {},
  }).default;
  return { model, state: () => ({ balance, entries, audits }) };
}
test('credit retries reuse the ledger entry and conflicting retries fail', async () => {
  const h = modelHarness();
  const input = { amount: '5.00', reason: 'Top up', request_id: id };
  const first = await h.model.addCredit('actor', id, input);
  assert.equal(first.balance_after, '15.00');
  const retry = await h.model.addCredit('actor', id, input);
  assert.equal(retry.replayed, true);
  assert.equal(h.state().entries.length, 1);
  assert.equal(h.state().audits.length, 1);
  await assert.rejects(h.model.addCredit('actor', id, { ...input, amount: '6.00' }), /different/);
  assert.equal(h.state().balance, '15.00');
});
test('audit failure rolls back both company balance and credit ledger', async () => {
  const h = modelHarness({ auditFails: true });
  await assert.rejects(
    h.model.addCredit('actor', id, { amount: '5.00', reason: 'Top up', request_id: id }),
    /audit failed/,
  );
  assert.equal(h.state().balance, '10.00');
  assert.equal(h.state().entries.length, 0);
});

function jwtHarness(user, company) {
  const db = (table) => ({
    where() {
      return this;
    },
    whereNull() {
      return this;
    },
    select() {
      return this;
    },
    first: async () => (table === 'users' ? user : company),
  });
  return load('library/surefy/src/middleware/jwtAuth.middleware.ts', {
    '../exceptions/HTTP401Error': HttpError,
    jsonwebtoken: { verify: () => ({ userId: id, role: 'superadmin', companyId: id }) },
    '../database': db,
  }).jwtAuthMiddleware;
}
test('JWT denies inactive users and inactive companies and uses the live role', async () => {
  for (const [user, company] of [
    [{ status: 'inactive', role: 'admin', company_id: id }, {}],
    [{ status: 'active', role: 'admin', company_id: id }, null],
  ]) {
    let error;
    await jwtHarness(user, company)({ headers: { authorization: 'Bearer token' } }, {}, (e) => {
      error = e;
    });
    assert.ok(error);
  }
  const req = { headers: { authorization: 'Bearer token' } };
  let error;
  await jwtHarness({ status: 'active', role: 'admin', company_id: id }, { id })(req, {}, (e) => {
    error = e;
  });
  assert.equal(error, undefined);
  assert.equal(req.userRole, 'admin');
});

test('user lists attach only the assigned plan for the same company and user',async()=>{
 const users=[{id:'u1',company_id:'c',assigned_plan:'p1'},{id:'u2',company_id:'c',assigned_plan:null},{id:'u3',company_id:'c',assigned_plan:'p2'}];
 const plans=[{id:'p1',user_id:'u1',company_id:'c',status:'EXPIRED',active:false},{id:'p2',user_id:'other-user',company_id:'c'}];
 let reads=0;
 const db=table=>{const query={whereNull(){return query;},where(value){if(typeof value==='function')value({orWhere(){}});return query;},select(){reads++;return Promise.resolve(plans);}};return query;};
 class BaseModel{constructor(){this.db=db;}}
 const model=load('src/app/models/superAdmin.model.ts',{'@surefy/models/base.model':{BaseModel},'@surefy/exceptions/HTTP400Error':HttpError,'@surefy/exceptions/HTTP404Error':HttpError,'./subscription.model':{}}).default;
 model.page=async()=>({items:users,pagination:{total:3,page:1,limit:25}});
 const result=await model.collection('users',{page:1,limit:25});
 assert.equal(result.items[0].plan_details.status,'EXPIRED');
 assert.equal(result.items[1].plan_details,null);
 assert.equal(result.items[2].plan_details,null);
 assert.equal(reads,1);assert.equal(result.pagination.total,3);
 model.page=async()=>({items:[],pagination:{total:0}});
 await model.collection('users',{page:1,limit:25});assert.equal(reads,1);
});

test('company status cascades only to non-deleted users in the same transaction', async () => {
  for (const status of ['active', 'suspended', 'inactive']) {
    for (const failAudit of [false, true]) {
      let companyStatus = 'active';
      const users = [
        { company_id: id, status: 'inactive', deleted_at: null },
        { company_id: id, status: 'suspended', deleted_at: null },
        { company_id: 'other', status: 'active', deleted_at: null },
        { company_id: id, status: 'inactive', deleted_at: 'deleted' },
      ];
      const db = (table) => {
        let filters = {}, nonDeleted = false, changes;
        const q = {
          where(value) { Object.assign(filters, value); return q; },
          whereNull() { nonDeleted = true; return q; },
          update(value) { changes = value; return q; },
          first: async () => undefined,
          returning: async () => { companyStatus = changes.status; return [{ id, status: companyStatus }]; },
          then(resolve, reject) {
            return Promise.resolve().then(() => {
              for (const user of users) {
                if (Object.entries(filters).every(([key, value]) => user[key] === value) && (!nonDeleted || !user.deleted_at))
                  user.status = changes.status;
              }
            }).then(resolve, reject);
          },
        };
        return q;
      };
      db.fn = { now: () => 'now' };
      db.transaction = async (fn) => {
        const before = [companyStatus, users.map(user => user.status)];
        try { return await fn(db); }
        catch (error) { companyStatus = before[0]; users.forEach((user, i) => user.status = before[1][i]); throw error; }
      };
      class BaseModel { constructor() { this.db = db; } }
      const model = load('src/app/models/superAdmin.model.ts', {
        '@surefy/models/base.model': { BaseModel },
        '@surefy/exceptions/HTTP400Error': HttpError,
        '@surefy/exceptions/HTTP404Error': HttpError,
        './subscription.model': {},
      }).default;
      model.company = async () => ({ id, status: companyStatus });
      model.audit = async () => { if (failAudit) throw Error('audit failed'); };
      const operation = model.updateCompany('actor', id, { status }, 'Status changed');
      if (failAudit) {
        await assert.rejects(operation, /audit failed/);
        assert.equal(companyStatus, 'active');
        assert.deepEqual(users.map(user => user.status), ['inactive', 'suspended', 'active', 'inactive']);
      } else {
        await operation;
        assert.equal(companyStatus, status);
        assert.deepEqual(users.map(user => user.status), [status, status, 'active', 'inactive']);
      }
    }
  }
});
