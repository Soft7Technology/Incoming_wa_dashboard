const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const knex = require('knex');
const express = require('express');
const jwt = require('jsonwebtoken');

function load(file, dependencies = {}) {
  const exports = {};
  const normalize = id => id.startsWith('@surefy/')
    ? path.resolve('library/surefy/src', id.slice('@surefy/'.length))
    : id.startsWith('.') ? path.resolve(path.dirname(file), id) : id;
  const injected = new Map(Object.entries(dependencies).map(([id, value]) => [normalize(id), value]));
  const compiled = process.env.SUPPORT_TEST_COMPILED_ROOT;
  const code = compiled
    ? fs.readFileSync(path.join(compiled, file.replace(/\.ts$/, '.js')), 'utf8')
    : require('typescript').transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: 7, module: 1, esModuleInterop: true },
    }).outputText;
  vm.runInNewContext(code, {
    exports, require: id => injected.has(normalize(id)) ? injected.get(normalize(id)) : require(id),
    process, Buffer, Date, URL, console, setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: file });
  return exports;
}
const httpError = code => class extends Error { constructor({ message }) { super(message); this.statusCode = code; } };
const errors = {
  '@surefy/exceptions/HTTP400Error': httpError(400),
  '@surefy/exceptions/HTTP401Error': httpError(401),
  '@surefy/exceptions/HTTP403Error': httpError(403),
  '@surefy/exceptions/HTTP404Error': httpError(404),
  '@surefy/exceptions/CustomError': { CustomError: class extends Error { constructor(message, code) { super(message); this.statusCode = code; } } },
  '@surefy/utils/HttpStatusCode': { HttpStatusCode: { CREATED: 201, CONFLICT: 409, TOO_MANY_REQUESTS: 429 } },
};
const validation = load('src/app/utils/supportValidation.ts', errors);

test('support input validation rejects malformed objects, UUIDs, unsafe bigint cursors and oversized messages', () => {
  for (const value of [undefined, [], 'text']) assert.throws(() => validation.supportObject(value));
  for (const value of ['', 'not-a-uuid', [], 1]) assert.throws(() => validation.supportUuid(value));
  for (const value of ['-1', '1.5', '9223372036854775808', 1, ['1'], '01']) assert.throws(() => validation.supportCursor(value));
  assert.equal(validation.supportCursor('9007199254740993'), '9007199254740993');
  assert.equal(validation.supportCursor('9223372036854775807'), '9223372036854775807');
  for (const value of ['', ' '.repeat(20), 'x'.repeat(10001), {}]) assert.throws(() => validation.supportText(value, 'message'));
  for (const value of ['0', '101', ['5'], '1.5']) assert.throws(() => validation.supportLimit(value));
  assert.throws(() => validation.supportStatus('anything'));
});

test('live support PostgreSQL, HTTP and cross-replica SSE integration', { skip: !process.env.SUPPORT_TEST_DATABASE_URL }, async t => {
  const connection = new URL(process.env.SUPPORT_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname), 'Tests require an isolated LOCAL PostgreSQL instance');
  assert.ok(connection.pathname.includes('support_test'), 'Tests require a dedicated support_test database');
  const db = knex({ client: 'pg', connection: connection.toString(), pool: { min: 0, max: 5 } });
  const migration = load('src/database/migrations/20261022000001_support_live_chat.ts');
  const ids = Object.fromEntries(['company', 'otherCompany', 'owner', 'peer', 'admin', 'secondAdmin', 'otherAdmin', 'member'].map(key => [key, crypto.randomUUID()]));
  const servers = [], hubs = [], closeStreams = [], aborters = [];
  let ticket;
  const secret = crypto.randomBytes(24).toString('hex');
  const priorSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  const token = user => jwt.sign({ userId: user, role: 'user', companyId: ids.otherCompany }, secret, { expiresIn: '10m' });
  try {
    await db.schema.createTable('companies', table => { table.uuid('id').primary(); table.text('status'); table.timestamp('deleted_at'); });
    await db.schema.createTable('users', table => {
      table.uuid('id').primary(); table.uuid('company_id');
      table.enu('role', ['user', 'admin', 'superadmin', 'member', 'viewer'], { useNative: true, enumName: 'role_enum' });
      table.text('status');
      table.text('name'); table.text('email'); table.text('phone'); table.timestamp('deleted_at');
    });
    await db('companies').insert([{ id: ids.company, status: 'active' }, { id: ids.otherCompany, status: 'active' }]);
    await db('users').insert([
      ['owner', 'user', 'company'], ['peer', 'user', 'company'], ['admin', 'admin', 'company'],
      ['secondAdmin', 'admin', 'company'], ['otherAdmin', 'admin', 'otherCompany'], ['member', 'member', 'company'],
    ].map(([name, role, company]) => ({ id: ids[name], company_id: ids[company], role, status: 'active', name, email: name + '@example.test' })));
    await migration.up(db);

    const serviceModule = load('src/app/services/supportLive.service.ts', { ...errors, '@surefy/database': db, '../utils/supportValidation': validation });
    const service = new serviceModule.SupportLiveService(db);
    const controllerHelpers = {
      tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
      successResponse: (_req, res, message, data, status = 200) => res.status(status).json({ success: true, message, data }),
    };
    const auth = load('library/surefy/src/middleware/jwtAuth.middleware.ts', {
      ...errors, '../database': db,
      '../utils/facebookReviewSession': { facebookReviewPurpose: 'not-a-review', facebookReviewSecret: key => key + '-review' },
    });
    for (let i = 0; i < 2; i++) {
      const { SupportEventHub } = load('src/app/services/supportEventHub.ts');
      const hub = new SupportEventHub(connection.toString()); hubs.push(hub);
      const controller = load('src/app/http/controllers/supportLive.controller.ts', {
        ...errors, '@surefy/utils/Controller': controllerHelpers,
        '../../services/supportLive.service': { __esModule: true, default: service },
        '../../services/supportEventHub': { supportEventHub: hub },
        '../../utils/supportValidation': validation,
      });
      closeStreams.push(controller.closeSupportStreams);
      const router = load('src/routes/supportLive.route.ts', { '../app/http/controllers/supportLive.controller': controller }).default;
      const app = express(); app.use(express.json());
      app.use('/v1/admin/support/live', auth.jwtAuthMiddleware, router);
      const legacyController = load('src/app/http/controllers/support.controller.ts', {
        '@surefy/utils/Controller': controllerHelpers, '../../services/support.service': { __esModule: true, default: service },
      }).default;
      const legacy = load('src/routes/support.route.ts', {
        './supportLive.route': { __esModule: true, default: router },
        '../app/http/controllers/support.controller': { __esModule: true, default: legacyController },
        '../app/http/controllers/superAdmin.controller': { __esModule: true, default: { authorize: (_q, _s, next) => next() } },
        '../app/http/controllers/superAdminOperations.controller': { __esModule: true, default: {
          forwarded() {}, escalate() {}, conversation() {}, changeTicket: () => (_q, res) => res.json({}),
        } },
      }).default;
      app.use('/v1/admin/support', auth.jwtAuthMiddleware, legacy);
      app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
      const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      servers.push(server);
    }
    const origin = index => 'http://127.0.0.1:' + servers[index].address().port;
    const api = async (who, route, body, method = body ? 'POST' : 'GET', replica = 0) => {
      const response = await fetch(origin(replica) + '/v1/admin/support/live' + route, {
        method, headers: { Authorization: 'Bearer ' + token(ids[who]), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, ...(await response.json()) };
    };
    async function stream(who, query = '', replica = 1) {
      const abort = new AbortController(); aborters.push(abort);
      const response = await fetch(origin(replica) + '/v1/admin/support/live/events' + query, {
        headers: { Authorization: 'Bearer ' + token(ids[who]) }, signal: abort.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      assert.equal(response.headers.get('x-accel-buffering'), 'no');
      const events = []; let buffer = ''; const decoder = new TextDecoder();
      const reader = response.body.getReader();
      const done = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const event = Object.fromEntries(frame.split('\n').filter(line => !line.startsWith(':')).map(line => {
                const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
              }));
              if (event.data) events.push({ ...event, data: JSON.parse(event.data) });
            }
          }
        } catch (error) { if (!abort.signal.aborted) throw error; }
      })();
      async function wait(predicate, timeout = 7000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const event = events.find(predicate); if (event) return event;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail('Expected SSE event not received');
      }
      await wait(event => event.event === 'ready');
      return { events, wait, abort, done };
    }

    await t.test('JWT required, company scope comes from the database, and admin directory is tenant-scoped', async () => {
      const anonymous = await fetch(origin(0) + '/v1/admin/support/live/admins'); assert.equal(anonymous.status, 401);
      const admins = await api('owner', '/admins'); assert.equal(admins.status, 200);
      assert.deepEqual(new Set(admins.data.map(row => row.id)), new Set([ids.admin, ids.secondAdmin]));
      const rejected = await api('owner', '/tickets', { message: 'Help', admin_id: ids.otherAdmin }); assert.equal(rejected.status, 400);
      const assigned = await api('owner', '/tickets', { message: 'Selected company admin', admin_id: ids.admin });
      assert.equal(assigned.status, 201, 'Admin validation must work when role_enum does not contain company');
      assert.equal(assigned.data.assigned_admin_id, ids.admin);
      await service.remove({ userId: ids.admin, companyId: ids.company }, assigned.data.id);
    });

    await t.test('ticket creation is atomic and retry-safe; another company user cannot read or mutate it', async () => {
      const key = crypto.randomUUID(); const body = { message: 'Please help me', subject: 'Live support', client_request_id: key };
      const created = await api('owner', '/tickets', body); assert.equal(created.status, 201); ticket = created.data;
      assert.equal(ticket.channel, 'live_chat');
      const duplicate = await api('owner', '/tickets', body); assert.equal(duplicate.data.id, ticket.id);
      assert.equal((await db('ticket_conversation').where({ ticket_id: ticket.id }).count('* as n').first()).n, '1');
      assert.equal((await api('owner', '/tickets', { ...body, message: 'Different' })).status, 409);
      for (const who of ['peer', 'otherAdmin', 'member']) {
        assert.equal((await api(who, '/tickets/' + ticket.id)).status, 404);
        assert.equal((await api(who, '/tickets/' + ticket.id + '/messages', { message: 'intrude' })).status, 404);
        assert.equal((await api(who, '/tickets/' + ticket.id + '/status', { status: 'closed' }, 'PATCH')).status, 404);
      }
      assert.equal((await api('peer', '/tickets')).data.items.length, 0);
      assert.equal((await api('admin', '/tickets')).data.items.length, 1);
    });

    await t.test('admin claims are atomic and users cannot impersonate an admin or change assignments', async () => {
      assert.equal((await api('owner', '/tickets/' + ticket.id + '/join', {})).status, 403);
      const claims = await Promise.all(['admin', 'secondAdmin'].map(who => api(who, '/tickets/' + ticket.id + '/join', {})));
      assert.deepEqual(claims.map(x => x.status).sort(), [200, 409]);
      await api('admin', '/tickets/' + ticket.id + '/assignment', { admin_id: ids.admin }, 'PATCH');
      assert.equal((await api('owner', '/tickets/' + ticket.id + '/assignment', { admin_id: ids.owner }, 'PATCH')).status, 403);
      assert.equal((await api('admin', '/tickets/' + ticket.id + '/assignment', { admin_id: ids.otherAdmin }, 'PATCH')).status, 400);
    });

    await t.test('user/admin messages push across API instances and repeated POSTs do not duplicate messages', async () => {
      const userStream = await stream('owner', '?ticket_id=' + ticket.id);
      const adminStream = await stream('admin');
      const peerStream = await stream('peer');
      const clientId = crypto.randomUUID(); const body = { message: 'Hello from the user', client_message_id: clientId };
      const replies = await Promise.all([api('owner', '/tickets/' + ticket.id + '/messages', body), api('owner', '/tickets/' + ticket.id + '/messages', body)]);
      assert.equal(replies[0].status, 200); assert.equal(replies[0].data.id, replies[1].data.id);
      const messageId = replies[0].data.id;
      const pushed = await adminStream.wait(e => e.event === 'message.created' && e.data.message.id === messageId, 2500);
      assert.equal(pushed.data.message.sender_role, 'user');
      assert.equal(typeof pushed.data.message.sequence, 'string');
      assert.equal(peerStream.events.filter(e => e.event === 'message.created').length, 0);
      assert.equal((await api('owner', '/tickets/' + ticket.id + '/messages', { ...body, message: 'Changed' })).status, 409);
      const reply = await api('admin', '/tickets/' + ticket.id + '/messages', { message: 'Admin is here', client_message_id: crypto.randomUUID(), user_id: ids.peer });
      assert.equal(reply.data.user_id, ids.admin);
      await userStream.wait(e => e.event === 'message.created' && e.data.message.id === reply.data.id);
      const history = await api('owner', '/tickets/' + ticket.id + '/messages?after=0&limit=2');
      assert.equal(history.data.items.length, 2); assert.equal(history.data.has_more, true);
      const next = await api('owner', '/tickets/' + ticket.id + '/messages?after=' + history.data.next_cursor);
      assert.equal(next.data.items.length, 1);
      const cursor = pushed.id;
      userStream.abort.abort(); adminStream.abort.abort(); peerStream.abort.abort();
      const resumed = await stream('owner', '?after=' + cursor + '&ticket_id=' + ticket.id);
      await resumed.wait(e => e.event === 'message.created' && e.data.message.id === reply.data.id);
      assert.equal(resumed.events.some(e => e.event === 'message.created' && e.data.message.id === messageId), false);
      resumed.abort.abort();
    });

    await t.test('closed tickets reject new messages, but acknowledge existing retries; reopening restores chat', async () => {
      const clientId = crypto.randomUUID(); const body = { message: 'Before closing', client_message_id: clientId };
      const sent = await api('owner', '/tickets/' + ticket.id + '/messages', body);
      await api('admin', '/tickets/' + ticket.id + '/status', { status: 'closed' }, 'PATCH');
      assert.equal((await api('owner', '/tickets/' + ticket.id + '/messages', { message: 'After closing' })).status, 409);
      assert.equal((await api('owner', '/tickets/' + ticket.id + '/messages', body)).data.id, sent.data.id);
      assert.equal((await api('owner', '/tickets/' + ticket.id + '/status', { status: 'open' }, 'PATCH')).status, 200);
      assert.equal((await api('owner', '/tickets/' + ticket.id + '/messages', { message: 'Reopened' })).status, 200);
    });

    await t.test('legacy endpoints are scoped and replies from legacy writers also create durable events', async () => {
      const legacy = await fetch(origin(0) + '/v1/admin/support/' + ticket.id + '/conversation', { headers: { Authorization: 'Bearer ' + token(ids.peer) } });
      assert.equal(legacy.status, 404);
      const before = await service.eventCursor({ userId: ids.owner, companyId: ids.company });
      const [inserted] = await db('ticket_conversation').insert({ ticket_id: ticket.id, company_id: ids.company, user_id: ids.admin, user_name: 'admin', message: 'Legacy writer' }).returning('*');
      const events = await service.events({ userId: ids.owner, companyId: ids.company }, before);
      assert.ok(events.some(event => event.type === 'message.created' && event.data.message.id === inserted.id));
      await assert.rejects(db.transaction(async tx => { await tx('ticket_conversation').insert({ ticket_id: ticket.id, company_id: ids.company, user_id: ids.owner, message: 'Rolled back' }); throw Error('rollback'); }));
      assert.equal((await db('support_ticket_events').whereRaw("data->'message'->>'message' = ?", ['Rolled back'])).length, 0);
    });

    await t.test('suspended users lose stream access and cannot use previously issued tokens', async () => {
      const live = await stream('owner');
      await db('users').where({ id: ids.owner }).update({ status: 'suspended' });
      const event = await live.wait(e => e.event === 'stream.error');
      assert.equal(event.data.code, 'ACCESS_REVOKED');
      assert.equal((await api('owner', '/tickets/' + ticket.id)).status, 401);
      await db('users').where({ id: ids.owner }).update({ status: 'active' });
      live.abort.abort();
    });

    await t.test('durable event cursors cannot skip an earlier uncommitted message', async () => {
      const scope = { userId: ids.owner, companyId: ids.company };
      const before = await service.eventCursor(scope);
      const first = await db.transaction(), second = await db.transaction();
      try {
        const [earlier] = await first('ticket_conversation').insert({ ticket_id: ticket.id, company_id: ids.company, user_id: ids.owner, message: 'Earlier transaction' }).returning('*');
        let laterFinished = false;
        const later = second('ticket_conversation').insert({ ticket_id: ticket.id, company_id: ids.company, user_id: ids.admin, message: 'Later transaction' }).returning('*').then(rows => { laterFinished = true; return rows[0]; });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(laterFinished, false, 'The company event lock must serialize event ID allocation');
        assert.equal((await service.events(scope, before)).length, 0, 'Uncommitted messages must not be replayed');
        await first.commit();
        const newer = await later; await second.commit();
        const events = await service.events(scope, before);
        assert.deepEqual(events.map(event => event.data.message.id), [earlier.id, newer.id]);
      } finally {
        if (!first.isCompleted()) await first.rollback();
        if (!second.isCompleted()) await second.rollback();
      }
    });

    await t.test('only admins delete tickets, and deletion is replayable without leaking other users', async () => {
      await assert.rejects(service.remove({ userId: ids.owner, companyId: ids.company }, ticket.id), e => e.statusCode === 403);
      const before = await service.eventCursor({ userId: ids.owner, companyId: ids.company });
      await service.remove({ userId: ids.admin, companyId: ids.company }, ticket.id);
      const events = await service.events({ userId: ids.owner, companyId: ids.company }, before);
      assert.ok(events.some(event => event.type === 'ticket.deleted' && event.data.ticket_id === ticket.id));
      assert.equal((await service.events({ userId: ids.peer, companyId: ids.company }, before)).length, 0);
    });

    await t.test('upgrading existing legacy tables backfills ordered history and preserves old tickets', async () => {
      await migration.down(db);
      const legacyId = crypto.randomUUID();
      await db('support_tickets').insert({ id: legacyId, user_id: ids.owner, company_id: ids.company, name: 'owner', email: 'owner@example.test', message: 'Legacy ticket' });
      await db('ticket_conversation').insert([
        { ticket_id: legacyId, company_id: ids.company, user_id: ids.owner, message: 'Older', created_at: '2025-01-01T00:00:00Z' },
        { ticket_id: legacyId, company_id: ids.company, user_id: ids.admin, message: 'Newer', created_at: '2025-01-02T00:00:00Z' },
      ]);
      await migration.up(db);
      const scope = { userId: ids.owner, companyId: ids.company };
      assert.equal((await service.get(scope, legacyId)).channel, 'ticket');
      const history = await service.messages(scope, legacyId);
      assert.deepEqual(Array.from(history.items, row => row.message), ['Older', 'Newer']);
      assert.deepEqual(Array.from(history.items, row => String(row.sequence)), ['1', '2']);
      const reply = await service.reply(scope, legacyId, { message: 'After migration' });
      assert.equal(String(reply.sequence), '3');
      assert.ok((await service.events(scope, '0')).some(event => event.type === 'message.created' && event.data.message.id === reply.id));
    });
  } finally {
    aborters.forEach(controller => controller.abort()); closeStreams.forEach(close => close());
    await Promise.all(hubs.map(hub => hub.close()));
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    try {
      await migration.down(db);
      assert.equal(await db.schema.hasTable('support_tickets'), true);
      assert.equal(await db.schema.hasColumn('support_tickets', 'subject'), false);
    } finally { await db.destroy(); }
    if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret;
  }
});
