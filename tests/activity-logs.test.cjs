const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const knex = require('knex');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
class HttpError extends Error { constructor(data) { super(data.message); } }
function load(file, deps) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, require: id => deps[id] || HttpError, Date, console });
  return exports;
}
const ids = { user: '11111111-1111-4111-8111-111111111111', other: '22222222-2222-4222-8222-222222222222',
  company: '33333333-3333-4333-8333-333333333333', log: '44444444-4444-4444-8444-444444444444' };
function setup() {
  const db = knex({ client: 'pg' }), queries = [], created = [];
  db.client.runner = builder => ({ run: async () => {
    const q = builder.toSQL(); queries.push(q);
    return q.sql.includes('count(') ? { total: '2' } : [];
  } });
  const activityContext = new AsyncLocalStorage();
  const context = { activityContext, markActivityRecorded: () => { const s = activityContext.getStore(); if (s) s.recorded = true; } };
  class BaseModel {
    constructor(table) { this.table = table; }
    query() { return db(this.table); }
    async create(data) { created.push(data); return data; }
  }
  const activityTypes = load('src/app/interfaces/activity.interface.ts', {});
  const validators = load('src/app/utils/activityFilters.ts', { '../interfaces/activity.interface': activityTypes });
  const model = load('src/app/models/activityLogs.model.ts', {
    '@surefy/models/base.model': { BaseModel }, '../utils/activityContext': context,
    '../utils/activityFilters': validators,
  }).default;
  return { db, model, queries, created, context };
}
test('company scope is grouped, action and type are AND filters, search cannot bypass scope', async () => {
  const h = setup();
  try {
    const result = await h.model.getAllActivities(ids.user, ids.company, 'admin', { type: 'contact', action: 'create', search: 'Alice', user_id: ids.other });
    assert.equal(result.pagination.total, 2);
    for (const q of h.queries) {
      assert.match(q.sql, /where "a"\."deleted_at" is null and \("a"\."company_id" = \? or \("a"\."company_id" is null and "u"\."company_id" = \?\)\) and UPPER/);
      assert.ok(q.bindings.includes('CONTACT') && q.bindings.includes('CREATE'));
      assert.ok(q.bindings.includes(ids.company) && q.bindings.includes(ids.other));
      assert.match(q.sql, /and \("a"\."description" ilike/);
      assert.ok(q.bindings.includes('%Alice%'));
    }
  } finally { await h.db.destroy(); }
});
test('ordinary users remain scoped to themselves despite role and user_id filters', async () => {
  const h = setup();
  try {
    await h.model.getAllActivities(ids.user, ids.company, 'member', { role: 'superadmin', user_id: ids.other });
    const q = h.queries[0];
    assert.ok(q.bindings.includes(ids.user) && q.bindings.includes(ids.company));
    assert.equal((q.sql.match(/"a"\."user_id" = \?/g) || []).length, 2);
    await assert.rejects(h.model.getCompanyNotifications(ids.user, ids.company, 'user', {}), /admin access/);
    await assert.rejects(h.model.getAllActivities(ids.user, undefined, 'admin', {}), /Company context/);
  } finally { await h.db.destroy(); }
});
test('action-only, dates, read flag, wildcard literals and pagination work together', async () => {
  const h = setup();
  try {
    await h.model.getAllActivities(ids.user, ids.company, 'superadmin', {
      action: 'LOGIN', date_from: '2026-09-01', date_to: '2026-09-23', read: 'false', search: '10%_off', limit: '500', page: '2',
    });
    const q = h.queries[0];
    assert.ok(q.bindings.includes('LOGIN') && q.bindings.includes(false));
    assert.ok(q.bindings.includes('%10\\%\\_off%'));
    assert.ok(q.bindings.some(v => v instanceof Date && v.toISOString() === '2026-09-24T00:00:00.000Z'));
    assert.deepEqual(q.bindings.slice(-2), [100, 100]);
    for (const filters of [{ page: -1 }, { limit: 1.2 }, { search: {} }, { user_id: 'bad' }, { date_from: '2026-02-30' }, { time_frame: 'unknown' }]) {
      await assert.rejects(h.model.getAllActivities(ids.user, ids.company, 'admin', filters));
    }
  } finally { await h.db.destroy(); }
});
test('mark-read is one scoped update and cannot update arbitrary other-user IDs', async () => {
  const h = setup();
  try {
    await h.model.markRead(ids.user, ids.company, 'user', [{ id: ids.log }]);
    assert.equal(h.queries.length, 1);
    assert.match(h.queries[0].sql, /^update "activity_logs" set "read" = \? where "id" in \(select "a"\."id"/);
    assert.ok(h.queries[0].bindings.includes(ids.user) && h.queries[0].bindings.includes(ids.company));
    await assert.rejects(h.model.markRead(ids.user, ids.company, 'user', [{}]), /required/);
  } finally { await h.db.destroy(); }
});
test('controller trusts authenticated role and caller, not query role or ownerId', async () => {
  let args, failure;
  const controller = load('src/app/http/controllers/activity.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse() {} },
    '../../services/activity.service': { getActivityLogs: async (...values) => { args = values; return {}; } },
  }).default;
  await controller.getActivityLogs({ companyId: ids.company, userId: ids.user, ownerId: ids.other, userRole: 'member', query: { role: 'superadmin' } }, {});
  assert.equal(args[1], ids.user); assert.equal(args[2], 'member');
});
test('detailed log records actual actor and fills missing company context', async () => {
  const h = setup();
  try {
    const context = { userId: ids.user, companyId: ids.company, recorded: false, request_method: 'POST', api_endpoint: '/v1/admin/contacts' };
    await h.context.activityContext.run(context, () => h.model.create({ user_id: ids.other, action: 'CREATE', entity_type: 'CONTACT' }));
    assert.equal(h.created[0].user_id, ids.user);
    assert.equal(h.created[0].company_id, ids.company);
    assert.equal(context.recorded, true);
  } finally { await h.db.destroy(); }
});
test('request fallback logs missing mutations without bodies/query secrets or duplicate domain logs', async () => {
  const h = setup();
  try {
    const middleware = load('src/app/middleware/activity.middleware.ts', {
      '../models/activityLogs.model': h.model, '../utils/activityContext': h.context,
    }).recordActivity;
    const req = { userId: ids.user, companyId: ids.company, method: 'POST', originalUrl: '/v1/admin/team/invite?token=secret',
      headers: {}, socket: {}, body: { password: 'secret' } };
    const response = code => Object.assign(new EventEmitter(), { statusCode: code });
    let res = response(201);
    middleware(req, res, () => res.emit('finish'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].entity_type, 'TEAM');
    assert.ok(!JSON.stringify(h.created).includes('secret'));
    res = response(201);
    middleware(req, res, () => { h.context.markActivityRecorded(); res.emit('finish'); });
    res = response(500); middleware(req, res, () => res.emit('finish'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.created.length, 1);
  } finally { await h.db.destroy(); }
});
