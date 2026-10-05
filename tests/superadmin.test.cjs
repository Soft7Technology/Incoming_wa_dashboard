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

test('individual user details scope counts, exclude deleted records and private fields', async () => {
  const rows = {
    users: [{ id: 'u', company_id: 'c', name: 'User', assigned_plan: 'p', password: 'secret', api_key: 'secret' }],
    campaigns: [{ user_id: 'u', company_id: 'c', status: 'running' }, { user_id: 'u', company_id: 'c', status: 'running' },
      { user_id: 'u', company_id: 'c', status: 'failed' }, { user_id: 'u', company_id: 'other', status: 'running' },
      { user_id: 'other', company_id: 'c', status: 'running' }, { user_id: 'u', company_id: 'c', status: 'running', deleted_at: 'deleted' }],
    contacts: [{ user_id: 'u', company_id: 'c' }, { user_id: 'u', company_id: 'c', deleted_at: 'deleted' }, { user_id: 'other', company_id: 'c' }],
    user_plans: [{ id: 'p', user_id: 'u', company_id: 'c', active: false, status: 'COMPLETED' }],
  };
  const db = table => {
    const filters = {}; let soft = false, counting = false;
    const selected = () => rows[table].filter(row => Object.entries(filters).every(([k,v]) => row[k] === v) && (!soft || !row.deleted_at));
    const q = {
      where(value) { Object.assign(filters,value); return q; }, whereNull() { soft = true; return q; },
      select() { return q; }, count() { counting = true; return q; },
      async first(...columns) {
        if (counting) return { count: String(selected().length) };
        const row = selected()[0];
        if (!row) return undefined;
        const keys = columns.flat(); return Object.fromEntries(keys.filter(k => k in row).map(k => [k,row[k]]));
      },
      async groupBy() {
        const groups = new Map(); for (const row of selected()) groups.set(row.status,(groups.get(row.status)||0)+1);
        return Array.from(groups, ([status,count]) => ({ status,count:String(count) }));
      },
    }; return q;
  };
  class BaseModel { constructor() { this.db = db; } }
  const model = load('src/app/models/superAdmin.model.ts', {
    '@surefy/models/base.model': { BaseModel }, '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError, './subscription.model': {},
  }).default;
  const result = await model.userDetails('u','c');
  assert.equal(result.stats.contacts_count,1);
  assert.equal(result.stats.campaigns_count,3);
  assert.equal(result.stats.campaigns_by_status.find(group => group.status === 'running').count,2);
  assert.equal(result.user.password,undefined); assert.equal(result.user.api_key,undefined);
  assert.equal(result.user.plan_details.active,false);
  await assert.rejects(model.userDetails('u','other'), /User not found/);
  rows.user_plans[0].user_id = 'other';
  assert.equal((await model.userDetails('u')).user.plan_details,null);
  rows.campaigns = []; rows.contacts = [];
  const empty = await model.userDetails('u');
  assert.equal(empty.stats.campaigns_count,0); assert.equal(empty.stats.contacts_count,0);
  assert.equal(empty.stats.campaigns_by_status.length,0);
  rows.users[0].deleted_at = 'deleted';
  await assert.rejects(model.userDetails('u'), /User not found/);
});

test('user details service validates route identifiers before database reads', async () => {
  let calls = 0;
  const s = service({ userDetails: async () => { calls++; return {}; } });
  assert.throws(() => s.userDetails('bad'), /UUID/);
  assert.throws(() => s.userDetails(id,'bad'), /UUID/);
  assert.equal(calls,0);
  await s.userDetails(id,id);
  assert.equal(calls,1);
});

function companyOverviewHarness(rows) {
  const sqlDb = knex({ client: 'pg' });
  const calls = [];
  const db = table => {
    const query = sqlDb(table);
    query.first = async (...columns) => {
      calls.push({ table, ...query.clone().first(...columns).toSQL() });
      const row = rows[table];
      if (!row || !columns.length) return row;
      return Object.fromEntries(columns.flat().filter(key => key in row).map(key => [key, row[key]]));
    };
    return query;
  };
  db.raw = (...args) => sqlDb.raw(...args);
  class BaseModel { constructor() { this.db = db; } }
  const model = load('src/app/models/superAdmin.model.ts', {
    '@surefy/models/base.model': { BaseModel },
    '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError,
    './subscription.model': {},
  }).default;
  return { model, calls, sqlDb };
}

test('company messaging overview scopes SQL, defines metrics and returns numeric counts without secrets', async () => {
  const h = companyOverviewHarness({
    companies: { id, name: 'Example', api_key: 'secret', config: { secret: true } },
    messages: { total_message: '150', delivered_messages: '100', failed_messages: '10',
      received_messages: '30', message_templates: '80' },
    templates: { total: '5' },
  });
  const result = await h.model.companyOverview(id);
  assert.deepEqual(JSON.parse(JSON.stringify(result.stats)), {
    total_message: 150, delivered_messages: 100, failed_messages: 10,
    received_messages: 30, templates: 5, message_templates: 80,
  });
  assert.equal(result.company.api_key, undefined);
  assert.equal(result.company.config, undefined);
  assert.equal(h.calls.length, 3);
  const company = h.calls.find(call => call.table === 'companies');
  assert.match(company.sql, /"deleted_at" is null/);
  assert.equal(company.bindings[0], id);
  const messages = h.calls.find(call => call.table === 'messages');
  assert.match(messages.sql, /where "company_id" = \? and not "status" = \?/);
  assert.equal(messages.bindings[0], id);
  assert.equal(messages.bindings[1], 'deleted');
  assert.match(messages.sql, /COUNT\(\*\) AS total_message/);
  assert.match(messages.sql, /direction = 'outbound' AND status IN \('delivered', 'read'\)/);
  assert.match(messages.sql, /direction = 'outbound' AND status = 'failed'/);
  assert.match(messages.sql, /WHERE direction = 'inbound'\) AS received_messages/);
  assert.match(messages.sql, /direction = 'outbound' AND type = 'template'/);
  const templates = h.calls.find(call => call.table === 'templates');
  assert.match(templates.sql, /where "company_id" = \? and "deleted_at" is null/);
  assert.equal(templates.bindings[0], id);
});

test('company overview returns zeros when empty and stops before metrics for a missing company', async () => {
  const empty = companyOverviewHarness({ companies: { id }, messages: {}, templates: { total: '0' } });
  const result = await empty.model.companyOverview(id);
  assert.equal(Object.keys(result.stats).length, 6);
  for (const count of Object.values(result.stats)) assert.equal(count, 0);
  const missing = companyOverviewHarness({});
  await assert.rejects(missing.model.companyOverview(id), /Company not found/);
  assert.equal(missing.calls.length, 1);
});

test('company overview validates company UUID before accessing the model', async () => {
  let requested;
  const s = service({ companyOverview: async companyId => { requested = companyId; return {}; } });
  assert.throws(() => s.companyOverview('bad'), /companyId must be a UUID/);
  assert.equal(requested, undefined);
  await s.companyOverview(id);
  assert.equal(requested, id);
});

test('company message and campaign lists validate filters, require company scope and reject missing companies', async () => {
  for (const resource of ['messages', 'campaigns']) {
    const calls = [];
    const s = service({
      company: async companyId => { calls.push(['company', companyId]); },
      collection: async (name, filters) => { calls.push([name, filters]); return { items: [] }; },
    });
    await assert.rejects(s.collection(resource, {}, 'bad'), /companyId must be a UUID/);
    await assert.rejects(s.collection(resource, {}), /companyId is required/);
    await assert.rejects(s.collection(resource, { domain_status: 'active' }, id), /domain_status/);
    await assert.rejects(s.collection(resource, { limit: '101' }, id), /Pagination/);
    await assert.rejects(s.collection(resource, { user_id: 'bad' }, id), /UUID/);
    await assert.rejects(s.collection(resource, { sort: 'config' }, id), /Unsupported/);
    await assert.rejects(s.collection(resource, { from: '2026-10-05', to: '2026-10-01' }, id), /from must precede/);
    assert.equal(calls.length, 0);
    await s.collection(resource, {
      company_id: 'ae815512-cf4b-4e7e-8472-16d3c2d4bb18', page: '2', limit: '10', user_id: id,
    }, id);
    assert.equal(calls[0][1], id);
    assert.equal(calls[1][1].company_id, id);
    assert.equal(calls[1][1].user_id, id);
    assert.equal(calls[1][1].page, 2);
    assert.equal(calls[1][1].limit, 10);
    let listed = false;
    const missing = service({
      company: async () => { throw new HttpError({ message: 'Company not found' }); },
      collection: async () => { listed = true; },
    });
    await assert.rejects(missing.collection(resource, {}, id), /Company not found/);
    assert.equal(listed, false);
  }
});

test('company message and campaign list/count queries share scope, deletion and search filters with bounded pagination', async () => {
  for (const resource of ['messages', 'campaigns']) {
    const h = companyOverviewHarness({});
    const queries = [];
    let empty = false;
    h.sqlDb.client.runner = builder => ({
      run: async () => {
        queries.push(builder.toSQL());
        if (builder._method === 'first') return { total: empty ? '0' : '2' };
        return empty ? [] : [{ id: 'record' }];
      },
    });
    const filters = {
      company_id: id, user_id: id, status: 'failed', search: 'test%_', page: 2, limit: 10,
      from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z',
    };
    const result = await h.model.collection(resource, filters);
    assert.equal(result.items[0].id, 'record');
    assert.equal(result.pagination.total, 2);
    assert.equal(result.pagination.page, 2);
    assert.equal(result.pagination.limit, 10);
    assert.equal(queries.length, 2);
    for (const query of queries) {
      assert.match(query.sql, /"company_id" = \?/);
      assert.match(query.sql, /"user_id" = \?/);
      assert.equal(query.bindings.filter(value => value === id).length, 2);
      assert.match(query.sql, /"status" = \?/);
      assert.ok(query.bindings.includes('failed'));
      assert.match(query.sql, /"created_at" >= \? and "created_at" < \?/);
      assert.ok(query.bindings.includes(filters.from));
      assert.ok(query.bindings.includes(filters.to));
      assert.ok(query.bindings.includes('%test\\%\\_%'));
      if (resource === 'messages') {
        assert.match(query.sql, /not "status" = \?/);
        assert.ok(query.bindings.includes('deleted'));
        assert.doesNotMatch(query.sql, /"deleted_at"/);
        assert.match(query.sql, /"from_phone" ilike \? or "to_phone" ilike \?/);
      } else {
        assert.match(query.sql, /"deleted_at" is null/);
        assert.match(query.sql, /"name" ilike \? or "description" ilike \?/);
      }
    }
    const list = queries.find(query => query.method === 'select');
    assert.match(list.sql, /order by "created_at" desc, "id" desc limit \? offset \?/);
    assert.equal(list.bindings.at(-2), 10);
    assert.equal(list.bindings.at(-1), 10);
    assert.doesNotMatch(list.sql, /select \*|"api_key"|"config"|"password"/);
    assert.match(list.sql, resource === 'messages' ? /"content"/ : /"total_recipients"/);
    empty = true;
    const noRecords = await h.model.collection(resource, { company_id: id, page: 1, limit: 25 });
    assert.equal(noRecords.items.length, 0);
    assert.equal(noRecords.pagination.total, 0);
  }
});
