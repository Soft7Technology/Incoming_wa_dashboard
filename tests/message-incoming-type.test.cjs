require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const phone = require('../src/app/utils/importPhone');

function load(file, deps = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports, require: id => id.endsWith('/activePhone') ? require('./helpers/active-phone.cjs') : id.endsWith('/databaseErrors') ? require('./helpers/background-database.cjs').databaseErrors : deps[id] || {},
    console: { log() {}, warn() {}, error() {} }, Date,
  });
  return exports;
}

function fixture() {
  const rows = [], events = [], botMessages = [];
  const business = { id: 'business', phone_number_id: 'meta-business', company_id: 'company', user_id: 'owner', display_phone_number: '+6587654321' };
  const service = load('src/app/services/message.service.ts', {
    '../utils/importPhone': phone,
    '@surefy/console/models/phoneNumber.model': { findByPhoneNumberId: async () => business },
    '../models/contact.model': { findOrCreateIncoming: async () => ({ id: 'contact', name: 'Customer' }) },
    '@surefy/console/models/message.model': { findByWamid: async () => undefined, createIncoming: async data => {
      const row = { ...data, id: `message-${rows.length}` };
      rows.push(row);
      return row;
    } },
    './contactOptOut.service': { incoming: async () => false },
    './socket-bridge': { publishSocketEvent: async (event, data) => events.push({ event, data }) },
  }).default;
  const controller = load('src/app/http/controllers/message.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn },
    '../../utils/metaWebhookStatus': require('../src/app/utils/metaWebhookStatus'),
    '@surefy/console/services/message.service': service,
    '@surefy/console/app/services/chatbot/chatbot.service': { handleIncomingMessageChatBot: async (_id, message) => botMessages.push(message) },
  }).default;
  const input = message => ({ phone_number_id: business.phone_number_id, message_id: message.id,
    from: message.from, type: message.type, content: message, context: message.context });
  return { service, controller, rows, events, botMessages, input };
}

const incoming = (type, extra = {}) => ({ id: `wamid.${type}`, from: '6581234567', type, ...extra });

test('unsupported messages retain the complete Meta payload and errors in the receiving account', async () => {
  const h = fixture();
  const payload = incoming('unsupported', { errors: [{ code: 131051, title: 'Unsupported message type' }], context: { id: 'wamid.original' } });
  const saved = await h.service.saveIncomingMessage(h.input(payload));
  assert.equal(saved.type, 'unsupported');
  assert.equal(saved.status, 'received');
  assert.equal(saved.direction, 'inbound');
  assert.equal(saved.content, payload);
  assert.equal(saved.context, payload.context);
  assert.equal(saved.wamid, payload.id);
  assert.equal(saved.company_id, 'company');
  assert.equal(saved.user_id, 'owner');
  assert.equal(saved.phone_number_id, 'business');
  assert.equal(saved.from_phone, payload.from);
  assert.equal(h.events[0].event, 'new_message');
});

test('unknown and missing inbound types are saved as unsupported without losing their original payloads', async () => {
  for (const type of ['future_meta_type', undefined, null, '']) {
    const h = fixture(), payload = incoming(type, { custom: { data: 'keep this' } });
    const saved = await h.service.saveIncomingMessage(h.input(payload));
    assert.equal(saved.type, 'unsupported');
    assert.equal(saved.content, payload);
    assert.equal(payload.type, type);
  }
});

test('supported inbound types retain their type and button replies remain interactive', async () => {
  for (const type of ['text', 'image', 'video', 'document', 'audio', 'template', 'interactive', 'location', 'contacts', 'sticker', 'reaction', 'button']) {
    const h = fixture(), payload = incoming(type, { text: { body: 'Hello' }, button: { text: 'Yes', payload: 'yes' } });
    const saved = await h.service.saveIncomingMessage(h.input(payload));
    assert.equal(saved.type, type === 'button' ? 'interactive' : type);
    if (type === 'text') assert.equal(saved.content.text, 'Hello');
    else if (type === 'button') assert.equal(saved.content.payload, 'yes');
    else assert.equal(saved.content, payload);
  }
});

test('webhook batches acknowledge unsupported rows, continue to normal messages and skip chatbot for unsupported rows', async () => {
  const h = fixture();
  const messages = [incoming('unsupported'), incoming('future_meta_type'), incoming('text', { text: { body: 'Hello' } })];
  let status, body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await h.controller.handleWebhook({ body: { entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'meta-business' }, messages,
  } }] }] } }, res);
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(h.rows.length, 3);
  assert.deepEqual(h.rows.map(row => row.type), ['unsupported', 'unsupported', 'text']);
  assert.deepEqual(h.botMessages, [messages[2]]);
});

test('type migration generates literal PostgreSQL checks for both known constraint names', async () => {
  const db = require('knex')({ client: 'pg' }), statements = [];
  db.client.runner = builder => ({ run: async () => { statements.push(builder.toSQL()); return {}; } });
  const migration = load('src/database/migrations/20261012000001_allow_unsupported_messages.ts');
  try {
    await migration.up(db);
    await migration.down(db);
    assert.equal(statements.length, 2);
    for (const statement of statements) {
      assert.match(statement.sql, /DROP CONSTRAINT IF EXISTS message_type_check/);
      assert.match(statement.sql, /DROP CONSTRAINT IF EXISTS messages_type_check/);
      assert.match(statement.sql, /ADD CONSTRAINT message_type_check CHECK/);
      assert.equal(statement.bindings.length, 0);
      assert.match(statement.sql, /'text'/);
      assert.match(statement.sql, /'sticker'/);
    }
    assert.match(statements[0].sql, /'unsupported'/);
    assert.match(statements[0].sql, /'reaction'/);
    assert.doesNotMatch(statements[1].sql, /'unsupported'|'reaction'/);
  } finally {
    await db.destroy();
  }
});
