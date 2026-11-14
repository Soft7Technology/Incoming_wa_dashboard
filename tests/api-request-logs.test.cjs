const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const express = require('express');
const { loadSource } = require('./helpers/background-database.cjs');

const bodyModule = loadSource('src/app/utils/apiLogBody.ts');
const { apiLogBody } = bodyModule;
const errors = {};
for (const statusCode of [400, 401, 403, 404]) errors[`@surefy/exceptions/HTTP${statusCode}Error`] = class extends Error {
  constructor({ message }) { super(message); this.statusCode = statusCode; }
};
const id = randomUUID(), userId = randomUUID(), companyId = randomUUID(), keyId = randomUUID();
const key = `s7_${'a'.repeat(64)}`;
const plain = value => JSON.parse(JSON.stringify(value));

test('audit bodies preserve messages, redact nested secrets and signed URLs, and bound large/cyclic inputs', () => {
  const input = { text: { body: 'Hello' }, password: 'hidden', nested: { access_token: 'hidden', Authorization: `Bearer ${key}` },
    messages: [{ image: { link: 'https://user:pass@cdn.example/image.jpg?sig=hidden#hidden' } }], value: key };
  const output = apiLogBody(input);
  assert.equal(output.text.body, 'Hello');
  assert.equal(output.messages[0].image.link, 'https://cdn.example/image.jpg?redacted');
  assert.ok(!JSON.stringify(output).includes('hidden'));
  assert.ok(!JSON.stringify(output).includes(key));
  assert.equal(input.password, 'hidden');
  input.cycle = input;
  assert.equal(apiLogBody(input).cycle, '[CIRCULAR]');
  assert.ok(Buffer.byteLength(JSON.stringify(apiLogBody({ list: Array.from({ length: 20000 }, () => ({ text: 'x'.repeat(100) })) }))) < 70000);
  assert.equal(apiLogBody({ body: 'x'.repeat(100000) }).body, '[TRUNCATED STRING]');
});

test('filters reject unbounded pagination, query arrays, invalid IDs and ambiguous dates', () => {
  const { apiLogFilters } = loadSource('src/app/services/apiRequestLog.service.ts', errors);
  assert.deepEqual(plain(apiLogFilters({})), { page: 1, limit: 20 });
  for (const query of [{ page: '0' }, { page: '1.2' }, { page: '1000001' }, { limit: '101' },
    { limit: ['2', '3'] }, { request_id: 'bad' }, { api_key_id: 'bad' }, { from_date: '2026-11-14' },
    { from_date: '2026-11-15T00:00:00Z', to_date: '2026-11-14T00:00:00Z' },
    { outcome: 'delivered' }, { http_status: '99' }, { method: 'DROP' }, { endpoint: '/v1/api/messages?token=a' }]) {
    assert.throws(() => apiLogFilters(query), error => error.statusCode === 400);
  }
  assert.equal(apiLogFilters({ status: 'read', page: '2' }, true).status, 'read');
  assert.throws(() => apiLogFilters({ status: 'read' }), error => error.statusCode === 400);
});

test('dashboard reads always use personal authenticated scope, including detail and summary', async () => {
  const calls = [];
  const service = loadSource('src/app/services/apiRequestLog.service.ts', { ...errors,
    '../models/apiRequestLog.model': {
      list: async (...args) => { calls.push(args); return {}; },
      summary: async (...args) => { calls.push(args); return {}; },
      detail: async (...args) => { calls.push(args); return undefined; },
    },
  }).default;
  const account = { userId, companyId, ownerId: randomUUID() };
  await service.list(account, { user_id: account.ownerId, company_id: randomUUID() });
  await service.summary(account, {});
  await assert.rejects(service.detail(account, id), error => error.statusCode === 404);
  for (const [scope] of calls) assert.deepEqual(plain(scope), { userId, companyId });
  assert.throws(() => service.list({}, {}), error => error.statusCode === 403);
});

async function serve(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('real Express API requests record success, validation/provider failures and 404 once; invalid keys cannot claim a user', async () => {
  const rows = new Map(); let completionCount = 0, sends = 0;
  const { authMiddleware } = loadSource('library/surefy/src/middleware/auth.middleware.ts', {
    '../exceptions/HTTP401Error': errors['@surefy/exceptions/HTTP401Error'],
    '../services/userApiKey.service': { authenticateUserApiKey: async supplied => supplied === key
      ? { userId, companyId, apiKeyId: keyId, apiKeyPrefix: key.slice(0, 12) } : null },
  });
  const { recordApiRequest } = loadSource('src/app/middleware/apiRequestLog.middleware.ts', {
    '../utils/apiLogBody': bodyModule,
    '../models/apiRequestLog.model': {
      create: async row => rows.set(row.id, { outcome: 'pending', ...row }),
      finish: async (id, data) => { completionCount++; Object.assign(rows.get(id), data); },
    },
  });
  const app = express(); app.use(express.json());
  app.use('/v1/api', authMiddleware, recordApiRequest);
  app.post('/v1/api/messages/send', (req, res, next) => {
    if (!req.body.to) return next(Object.assign(Error('Recipient required'), { statusCode: 400 }));
    if (req.body.to === 'provider-error') return next(Object.assign(Error('Provider rejected message'), { statusCode: 502 }));
    sends++; res.status(201).json({ success: true, data: { id: randomUUID(), access_token: 'provider-secret' } });
  });
  app.post('/v1/api/application-failure', (_req, res) => res.json({ success: false, message: 'Failed' }));
  app.use((_req, res) => res.status(404).json({ success: false, message: 'Not found' }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  await serve(app, async base => {
    const request = (path, body, headers = { 'x-api-key': key }) => fetch(`${base}/v1/api/${path}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const accepted = await request('messages/send?access_token=query-secret', { to: '123', text: { body: 'Hello' }, api_key: key });
    assert.equal(accepted.status, 201);
    assert.ok(accepted.headers.get('x-api-request-id'));
    assert.equal((await request('messages/send', {}, { Authorization: `Bearer ${key}` })).status, 400);
    assert.equal((await request('messages/send', { to: 'provider-error' })).status, 502);
    assert.equal((await request('missing', {})).status, 404);
    assert.equal((await request('application-failure', {})).status, 200);
    assert.equal((await request('messages/send', { to: '123' }, { 'x-api-key': 'invalid' })).status, 401);
    assert.equal((await request('messages/send', { to: '123' }, { 'x-api-key': key, Authorization: 'Bearer different' })).status, 401);
  });
  assert.equal(sends, 1); assert.equal(rows.size, 5); assert.equal(completionCount, 5);
  assert.equal([...rows.values()].filter(row => row.outcome === 'failed').length, 4);
  const saved = [...rows.values()][0];
  assert.equal(saved.user_id, userId); assert.equal(saved.api_key_id, keyId);
  assert.equal(saved.endpoint, '/v1/api/messages/send');
  assert.equal(JSON.parse(saved.request_body).text.body, 'Hello');
  const json = JSON.stringify([...rows.values()]);
  for (const secret of [key, 'query-secret', 'provider-secret']) assert.ok(!json.includes(secret));
});

test('logging failure prevents an untracked send; disconnect records aborted once', async () => {
  const req = { userId, companyId, apiKeyId: keyId, method: 'POST', originalUrl: '/v1/api/messages/send', body: {}, query: {} };
  let entered = false;
  const res = Object.assign(new EventEmitter(), { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const failed = loadSource('src/app/middleware/apiRequestLog.middleware.ts', {
    '../utils/apiLogBody': bodyModule, '../models/apiRequestLog.model': { create: async () => { throw Error('database password secret'); } },
  }).recordApiRequest;
  await failed(req, res, () => { entered = true; });
  assert.equal(res.statusCode, 503); assert.equal(entered, false); assert.ok(!JSON.stringify(res.body).includes('password'));
  const finishes = [];
  const working = loadSource('src/app/middleware/apiRequestLog.middleware.ts', {
    '../utils/apiLogBody': bodyModule, '../models/apiRequestLog.model': {
      create: async () => {}, finish: async (_id, data) => finishes.push(data),
    },
  }).recordApiRequest;
  await working(req, res, () => { entered = true; });
  res.emit('close'); res.emit('finish');
  assert.equal(finishes.length, 1); assert.equal(finishes[0].outcome, 'aborted'); assert.equal(finishes[0].http_status, null);
});

test('single-send validation failures are linked to the audit before sending', async () => {
  const calls = [];
  const service = loadSource('src/app/services/message.service.ts', { ...errors,
    '@surefy/console/models/phoneNumber.model': { findByPhoneNumberId: async () => null },
    '../models/apiRequestLog.model': {
      startMessage: async (...args) => calls.push(['start', ...args]),
      failMessage: async (...args) => calls.push(['failed', ...args]),
    },
  }).default;
  const body = { phone_number_id: 'not-owned', to: '123', type: 'text' };
  await assert.rejects(service.sendMessage({ ...body, user_id: userId, company_id: companyId },
    { apiRequestId: id, apiRequestBody: body }), /Phone number not found/);
  assert.equal(calls[0][0], 'start'); assert.equal(calls[1][0], 'failed');
  assert.equal(calls[0][1], id); assert.equal(calls[0][2], calls[1][2]);
  assert.deepEqual(calls[0][3], body);
});

test('bulk sends reserve independent IDs before queueing, ignoring caller audit IDs; uncertain queue outcomes are recorded', async () => {
  let reserved, queued, failJob;
  const service = loadSource('src/app/services/message.service.ts', { ...errors,
    '../models/user.model': { findById: async () => ({ id: userId, company_id: companyId }) },
    '@surefy/console/models/phoneNumber.model': { findOwnedByIdentifiers: async () => [{ id: 'internal', phone_number_id: 'sender' }] },
    '../utils/activePhone': { assertActivePhone() {} },
    '../models/apiRequestLog.model': {
      reserveMessages: async (...args) => { reserved = args; },
      failJob: async (...args) => { failJob = args; },
    },
    '../../queues/bulkMessageSend.queue': { bulkMessageSendQueue: { add: async (_name, data) => {
      assert.ok(reserved); queued = data; return { id: 'job' };
    } } },
  }).default;
  const callerId = randomUUID();
  const body = { phone_number_id: 'sender', type: 'text', to: '123', messageUUID: callerId, apiRequestId: 'forged' };
  const result = await service.bulkSendMessages(userId, [body, body], id);
  assert.equal(queued.apiRequestId, id); assert.equal(reserved[0], id);
  const ids = result.messages.map(message => message.message_id);
  assert.equal(new Set(ids).size, 2); assert.ok(!ids.includes(callerId));
  assert.deepEqual(plain(reserved[1].map(row => row.id)), plain(ids));
  assert.equal(queued.messages[0].company_id, companyId);
  // A second fixture tests an ambiguous Redis acknowledgement without replaying the send.
  const failing = loadSource('src/app/services/message.service.ts', { ...errors,
    '../models/user.model': { findById: async () => ({ company_id: companyId }) },
    '@surefy/console/models/phoneNumber.model': { findOwnedByIdentifiers: async () => [{ id: 'internal', phone_number_id: 'sender' }] },
    '../utils/activePhone': { assertActivePhone() {} },
    '../models/apiRequestLog.model': { reserveMessages: async () => {}, failJob: async (...args) => { failJob = args; } },
    '../../queues/bulkMessageSend.queue': { bulkMessageSendQueue: { add: async () => { throw Error('Redis unavailable'); } } },
  }).default;
  await assert.rejects(failing.bulkSendMessages(userId, [body], id), /Redis unavailable/);
  assert.deepEqual(failJob, [id, true]);
});

test('bulk worker forwards reserved message IDs and trusted request correlation for interactive messages', async () => {
  let processJob, sent;
  loadSource('src/queues/processors/bulkMessageSend.processor.ts', {
    '../../workers/drain': { isWorkerDraining: () => false },
    '../databaseAwareWorker': { createDatabaseAwareWorker: (_name, processor) => { processJob = processor; return new EventEmitter(); } },
    '@surefy/console/app/models/user.model': { findById: async () => ({ id: userId }) },
    '@surefy/console/services/message.service': { sendMessage: async (...args) => { sent = args; return {}; } },
  });
  const messageId = randomUUID(), interactive = { type: 'button', body: { text: 'Choose' }, action: { buttons: [] } };
  const job = { id: 'job', data: { userId, apiRequestId: id, messages: [{ messageUUID: messageId,
    company_id: companyId, type: 'interactive', interactive, to: '123', apiRequestId: 'forged' }] },
    discard() {}, async updateData() {}, async updateProgress() {},
  };
  await processJob(job);
  assert.equal(sent[0].messageUUID, messageId); assert.deepEqual(sent[0].interactive, interactive);
  assert.equal(sent[1].apiRequestId, id);
});

test('PostgreSQL: migration, pagination, tenant isolation, webhook statuses and revoked-key history',
  { skip: !process.env.API_LOG_TEST_DATABASE_URL }, async () => {
    const db = require('knex')({ client: 'pg', connection: process.env.API_LOG_TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
    const schema = `api_log_test_${randomUUID().replaceAll('-', '')}`;
    const rollback = new Error('ROLLBACK_TEST_SCHEMA');
    try {
      await assert.rejects(db.transaction(async trx => {
        await trx.raw('CREATE SCHEMA ??', [schema]);
        await trx.raw('SET LOCAL search_path TO ??, pg_catalog', [schema]);
        for (const table of ['users', 'companies', 'user_api_keys']) {
          await trx.schema.createTable(table, t => { t.uuid('id').primary(); });
        }
        await trx.schema.createTable('messages', t => {
          for (const name of ['id', 'user_id', 'company_id']) t.uuid(name);
          t.primary(['id']);
          for (const name of ['status', 'wamid', 'to_phone', 'type', 'error_code', 'error_message']) t.text(name);
          for (const name of ['queued_at', 'sent_at', 'delivered_at', 'read_at', 'failed_at']) t.timestamp(name);
        });
        const migration = loadSource('src/database/migrations/20261114000001_api_request_logs.ts');
        await migration.up(trx);
        const otherUser = randomUUID(), otherCompany = randomUUID();
        await trx('users').insert([{ id: userId }, { id: otherUser }]);
        await trx('companies').insert([{ id: companyId }, { id: otherCompany }]);
        await trx('user_api_keys').insert({ id: keyId });
        const model = loadSource('src/app/models/apiRequestLog.model.ts', {
          '@surefy/database': trx, '../utils/apiLogBody': bodyModule,
        }).default;
        const scope = { userId, companyId }, firstId = randomUUID(), secondId = randomUUID();
        const base = { user_id: userId, company_id: companyId, api_key_id: keyId, key_prefix: key.slice(0, 12),
          method: 'POST', endpoint: '/v1/api/messages/send', request_body: JSON.stringify({ text: { body: 'hello' } }) };
        await model.create({ ...base, id: firstId, created_at: new Date('2026-11-14T01:00:00Z') });
        await model.create({ ...base, id: secondId, created_at: new Date('2026-11-14T02:00:00Z') });
        const foreignId = randomUUID();
        await model.create({ ...base, id: foreignId, user_id: otherUser });
        await model.create({ ...base, id: randomUUID(), company_id: otherCompany });
        await model.finish(firstId, { outcome: 'success', http_status: 201 });
        await model.finish(firstId, { outcome: 'failed', http_status: 500 }); // Finish/close cannot double-count.
        await model.finish(secondId, { outcome: 'failed', http_status: 400 });
        const messageIds = [randomUUID(), randomUUID(), randomUUID()];
        await model.reserveMessages(firstId, messageIds.map(id => ({ id, body: { to: '123', type: 'text', text: { body: 'Hi' } } })));
        await model.startMessage(firstId, messageIds[0], { changed: 'must not replace original' });
        await model.failMessage(firstId, messageIds[1], 'Recipient is invalid');
        await trx('messages').insert({ id: messageIds[0], user_id: userId, company_id: companyId, status: 'delivered',
          wamid: 'wamid.test', to_phone: '123', type: 'text' });
        // A record from another tenant must never be joined even if its ID matches.
        await trx('messages').insert({ id: messageIds[2], user_id: otherUser, company_id: companyId, status: 'read' });
        const filters = { page: 1, limit: 1 };
        const page = await model.list(scope, filters);
        assert.equal(page.pagination.total, 2); assert.equal(page.items[0].id, secondId); assert.equal(page.pagination.has_next, true);
        const page2 = await model.list(scope, { ...filters, page: 2 });
        assert.equal(page2.items[0].id, firstId); assert.equal(page2.pagination.has_next, false);
        assert.equal(await model.detail(scope, foreignId), undefined);
        const summary = await model.summary(scope, filters);
        assert.deepEqual(plain(summary.requests), { total: 2, success: 1, failed: 1, pending: 0, aborted: 0 });
        assert.equal(summary.messages.total, 3); assert.equal(summary.messages.delivered, 1);
        assert.equal(summary.messages.failed, 1); assert.equal(summary.messages.queued, 1); assert.equal(summary.messages.read, 0);
        const messages = await model.list(scope, { page: 1, limit: 20, status: 'delivered' }, true);
        assert.equal(messages.pagination.total, 1); assert.equal(messages.items[0].request_body.text.body, 'Hi');
        await trx('messages').where({ id: messageIds[0] }).update({ status: 'read' });
        assert.equal((await model.summary(scope, filters)).messages.read, 1);
        assert.equal((await model.list(scope, { ...filters, from_date: new Date('2026-11-14T01:30:00Z') })).pagination.total, 1);
        await trx('user_api_keys').where({ id: keyId }).delete();
        assert.equal((await model.detail(scope, firstId)).api_key_id, null);
        assert.equal((await model.summary(scope, filters)).requests.total, 2);
        await migration.down(trx);
        assert.equal(await trx.schema.hasTable('api_request_logs'), false);
        throw rollback;
      }), error => error === rollback);
      assert.equal((await db.raw('SELECT 1 FROM pg_namespace WHERE nspname = ?', [schema])).rows.length, 0);
    } finally { await db.destroy(); }
  });
