require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const knex = require('knex');
const phone = require('../src/app/utils/importPhone');
const { processMetaStatusBatch } = require('../src/app/utils/metaWebhookStatus');

function load(file, deps = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => id.endsWith('/databaseErrors') ? require('./helpers/background-database.cjs').databaseErrors : deps[id] || {}, Date,
    console: { log() {}, info() {}, warn() {}, error() {} } });
  return exports.default;
}

function incomingFixture({ race = false, existing = false, failure } = {}) {
  const rows = [], downloads = [], preferences = [], events = [], bots = [], inserts = [];
  const business = { id: 'business', phone_number_id: 'meta-business', user_id: 'owner', company_id: 'company' };
  const service = load('src/app/services/message.service.ts', {
    '../utils/importPhone': phone,
    '@surefy/exceptions/HTTP400Error': class extends Error { constructor({ message }) { super(message); } },
    '@surefy/console/models/phoneNumber.model': { findByPhoneNumberId: async () => business },
    '../models/contact.model': { findOrCreateIncoming: async () => ({ id: 'contact', name: 'Customer' }) },
    '@surefy/console/models/message.model': {
      findByWamid: async wamid => race ? undefined : existing ? { id: 'existing' } : rows.find(row => row.wamid === wamid),
      createIncoming: async data => {
        inserts.push(data);
        if (failure) throw failure;
        if (rows.some(row => row.wamid === data.wamid)) return undefined;
        const row = { ...data, id: 'message' }; rows.push(row); return row;
      },
    },
    '../utils': { downloadMedia: async id => { downloads.push(id); return { firebaseUrl: 'https://media.example.test/image.jpg' }; } },
    './contactOptOut.service': { incoming: async (...args) => { preferences.push(args); return false; } },
    './socket-bridge': { publishSocketEvent: async (...args) => events.push(args) },
  });
  const controller = load('src/app/http/controllers/message.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn },
    '../../utils/metaWebhookStatus': { processMetaStatusBatch },
    '@surefy/console/services/message.service': service,
    '@surefy/console/app/services/chatbot/chatbot.service': { handleIncomingMessageChatBot: async (...args) => bots.push(args) },
  });
  const raw = { id: 'wamid.incoming', from: '6581234567', type: 'image', image: { id: 'media-image' } };
  const input = { phone_number_id: 'meta-business', message_id: raw.id, from: raw.from, type: raw.type, content: raw };
  return { service, controller, rows, downloads, preferences, events, bots, inserts, raw, input };
}

test('repeated media webhooks acknowledge 200 without a second download, row, notification or chatbot response', async () => {
  const h = incomingFixture();
  const req = { body: { entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'meta-business' }, messages: [h.raw],
  } }] }] } };
  const responses = [];
  const res = { status(value) { responses.push(value); return this; }, json(value) { assert.equal(value.success, true); } };
  await h.controller.handleWebhook(req, res);
  await h.controller.handleWebhook(req, res);
  assert.deepEqual(responses, [200, 200]);
  for (const values of [h.downloads, h.rows, h.preferences, h.events, h.bots, h.inserts]) assert.equal(values.length, 1);
});

test('concurrent inbound deliveries run side effects once even when both prechecks miss', async () => {
  const h = incomingFixture({ race: true });
  const results = await Promise.all([h.service.saveIncomingMessage(h.input), h.service.saveIncomingMessage(h.input)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(h.inserts.length, 2);
  for (const values of [h.rows, h.preferences, h.events]) assert.equal(values.length, 1);
});

test('an existing WAMID is skipped before media work and unrelated persistence failures still propagate', async () => {
  const duplicate = incomingFixture({ existing: true });
  assert.equal(await duplicate.service.saveIncomingMessage(duplicate.input), null);
  assert.equal(duplicate.downloads.length, 0);
  assert.equal(duplicate.inserts.length, 0);
  const failure = Object.assign(new Error('Another unique constraint failed'), { code: '23505', constraint: 'other_unique' });
  const h = incomingFixture({ failure });
  await assert.rejects(h.service.saveIncomingMessage(h.input), error => error === failure);
  assert.equal(h.events.length, 0);
});

test('missing inbound IDs fail before media or insert', async () => {
  const h = incomingFixture();
  await assert.rejects(h.service.saveIncomingMessage({ ...h.input, message_id: undefined }), /message ID is required/);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.inserts.length, 0);
});

test('model uses targeted ON CONFLICT DO NOTHING and preserves JSON payloads', async () => {
  const db = knex({ client: 'pg' }), queries = [];
  db.client.runner = builder => ({ run: async () => { queries.push(builder.toSQL()); return []; } });
  class BaseModel { query() { return db('messages'); } }
  const model = load('src/app/models/message.model.ts', { '@surefy/models/base.model': { BaseModel } });
  try {
    assert.equal(await model.createIncoming({ wamid: 'wamid.duplicate', content: { image: { id: 'media' } }, context: { id: 'reply' }, created_at: new Date() }), undefined);
    assert.match(queries[0].sql, /on conflict \("wamid"\) do nothing returning \*/);
    assert.ok(queries[0].bindings.includes(JSON.stringify({ image: { id: 'media' } })));
    assert.ok(queries[0].bindings.includes(JSON.stringify({ id: 'reply' })));
    assert.ok(queries[0].bindings.some(value => value instanceof Date));
  } finally { await db.destroy(); }
});

test('statuses from later entries are applied before any inbound media work', async () => {
  const order = [];
  const controller = load('src/app/http/controllers/message.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn },
    '../../utils/metaWebhookStatus': { processMetaStatusBatch },
    '@surefy/console/services/message.service': {
      handleStatusUpdate: async data => order.push(`status:${data.wamid}`),
      saveIncomingMessage: async () => { order.push('media'); return null; },
    },
  });
  await controller.handleWebhook({ body: { entry: [
    { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'meta' }, messages: [{ id: 'inbound' }] } }] },
    { changes: [{ field: 'messages', value: { statuses: [{ id: 'outbound', status: 'read', timestamp: '1791785263' }] } }] },
  ] } }, { status() { return this; }, json() {} });
  assert.deepEqual(order, ['status:outbound', 'media']);
});

test('status processing caps concurrency at five while preserving each WAMID sequence', async () => {
  let active = 0, maximum = 0;
  const completed = new Map();
  const statuses = Array.from({ length: 12 }, (_, id) => ['sent', 'delivered', 'read'].map(status => ({ id: String(id), status }))).flat();
  await processMetaStatusBatch([{ statuses }], async update => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    const list = completed.get(update.id) || []; list.push(update.status); completed.set(update.id, list);
    active--;
  });
  assert.equal(maximum, 5);
  assert.equal(completed.size, 12);
  for (const list of completed.values()) assert.deepEqual(list, ['sent', 'delivered', 'read']);
});

test('a failed status batch waits for other writes and propagates errors for Meta retry', async () => {
  let finished = false;
  await assert.rejects(processMetaStatusBatch([{ statuses: [{ id: 'bad' }, { id: 'good' }] }], async update => {
    if (update.id === 'bad') throw Error('Database unavailable');
    await new Promise(resolve => setImmediate(resolve)); finished = true;
  }), /Database unavailable/);
  assert.equal(finished, true);
});

test('status handling writes before slow reminder tracking without a preliminary message lookup', async () => {
  let finishTracking, wrote = false;
  const tracking = new Promise(resolve => { finishTracking = resolve; });
  const hooks = [], row = { id: 'outbound', company_id: 'company' };
  const service = load('src/app/services/message.service.ts', {
    './reminderDelivery.service': { recordReminderDelivery: () => tracking },
    '@surefy/console/models/message.model': {
      findByWamid: () => { throw Error('Unnecessary lookup'); },
      updateStatus: async (wamid, status, data) => {
        assert.equal(wamid, 'wamid.outbound'); assert.equal(status, 'read');
        assert.equal(data.event_at.toISOString(), '2026-10-12T06:07:43.000Z');
        wrote = true; return [row];
      },
    },
    '@surefy/console/services/webhook.service': { triggerWebhook: async (...args) => hooks.push(args) },
  });
  const pending = service.handleStatusUpdate({ wamid: 'wamid.outbound', status: 'read', timestamp: '1791785263' });
  assert.equal(wrote, true);
  finishTracking();
  assert.equal(await pending, row);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0][1], 'message.read');
});

test('duplicate or stale status writes do not resend client hooks and invalid statuses do no work', async () => {
  const updates = [], reminders = [], hooks = [];
  const service = load('src/app/services/message.service.ts', {
    './reminderDelivery.service': { recordReminderDelivery: async data => reminders.push(data) },
    '@surefy/console/models/message.model': { updateStatus: async (...args) => { updates.push(args); return []; } },
    '@surefy/console/services/webhook.service': { triggerWebhook: async (...args) => hooks.push(args) },
  });
  const input = { wamid: 'wamid.outbound', status: 'read', timestamp: 1791785263 };
  assert.equal(await service.handleStatusUpdate(input), null);
  for (const change of [{ status: 'invalid' }, { timestamp: 'invalid' }, { timestamp: 0 }, { wamid: '' }]) {
    assert.equal(await service.handleStatusUpdate({ ...input, ...change }), null);
  }
  assert.equal(updates.length, 1);
  assert.equal(reminders.length, 1);
  assert.equal(hooks.length, 0);
});

test('status model uses atomic transition guards, Meta timestamps and never allows read to regress', async () => {
  const db = knex({ client: 'pg' }), queries = [];
  db.client.runner = builder => ({ run: async () => { queries.push(builder.toSQL()); return []; } });
  class BaseModel { query() { return db('messages'); } }
  const model = load('src/app/models/message.model.ts', { '@surefy/models/base.model': { BaseModel } });
  const eventAt = new Date('2026-10-12T06:07:43Z');
  try {
    for (const status of ['sent', 'delivered', 'read', 'failed']) {
      await model.updateStatus('wamid.outbound', status, { event_at: eventAt, error_code: 131026, error_message: 'Failed' });
      const query = queries.at(-1);
      assert.match(query.sql, /^update "messages"/);
      assert.match(query.sql, /"wamid" = \? and "direction" = \? and "status" in/);
      assert.match(query.sql, /returning \*/);
      assert.ok(query.bindings.includes(eventAt));
      assert.ok(query.bindings.includes('outbound'));
      const allowed = query.bindings.slice(query.bindings.indexOf('outbound') + 1);
      assert.ok(!allowed.includes('read'));
      if (status !== 'read') assert.ok(!allowed.includes('delivered'));
      if (status === 'failed') assert.ok(query.bindings.includes('131026'));
    }
    assert.match(queries[0].sql, /"failed_at" is null or "failed_at" <= \?/);
    assert.match(queries[3].sql, /"sent_at" is null or "sent_at" < \?/);
    assert.ok(queries[3].bindings.some(value => value instanceof Date && value.getTime() === eventAt.getTime() + 1000));
    await model.updateStatus('wamid.outbound', 'invalid');
    assert.equal(queries.length, 4);
  } finally { await db.destroy(); }
});
