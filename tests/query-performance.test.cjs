require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const knex = require('knex');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Optional before Node 22. */ }
class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, require: name => name.endsWith('/activePhone') ? require('./helpers/active-phone.cjs') : deps[name] || (name.includes('Error') ? HttpError : {}),
    console: { log() {}, warn() {}, error() {} } });
  return exports.default || exports;
}

test('list pagination fetches only its page with accurate scoped totals and stable ordering',
  { skip: !DatabaseSync }, async () => {
  const sqlite = new DatabaseSync(':memory:'), db = knex({ client: 'pg' }), statements = [];
  sqlite.exec(`CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT, phone_number_id TEXT,
    name TEXT, created_at INTEGER, deleted_at TEXT, is_valid INTEGER);
    CREATE TABLE contact_list_relations (contact_id TEXT, list_id TEXT, PRIMARY KEY(contact_id, list_id));`);
  const insert = sqlite.prepare('INSERT INTO contacts VALUES (?,?,?,?,?,?,?,?)');
  const relation = sqlite.prepare('INSERT INTO contact_list_relations VALUES (?,?)');
  for (let i = 0; i < 300; i++) {
    const id = String(i).padStart(3, '0');
    insert.run(id, i < 270 || i >= 280 ? 'owner' : 'foreign', i < 280 || i >= 290 ? 'company' : 'foreign',
      'sender', id, i, i >= 290 ? 'deleted' : null, i % 2);
    relation.run(id, 'selected');
  }
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL(); statements.push(query);
    const rows = sqlite.prepare(query.sql).all(...query.bindings.map(value => typeof value === 'boolean' ? Number(value) : value));
    return query.method === 'first' ? rows[0] : rows;
  } });
  class BaseModel { constructor(table) { this.db = db; this.tableName = table; } query() { return db(this.tableName); } }
  const model = load('src/app/models/contactListRelation.model.ts', { '@surefy/models/base.model': { BaseModel } });
  const service = load('src/app/services/contact.service.ts', { '../models/contactListRelation.model': model });
  try {
    const page = await service.getListContacts('selected', { user_id: 'owner', company_id: 'company', page: 2, limit: 20, is_valid: true });
    assert.equal(page.total, 135); assert.equal(page.page, 2); assert.equal(page.limit, 20);
    assert.equal(page.contacts.length, 20); assert.equal(page.contacts[0].id, '229');
    assert.ok(page.contacts.every(row => row.user_id === 'owner' && row.company_id === 'company' && row.deleted_at === null && row.is_valid === 1));
    assert.equal(statements.length, 2);
    assert.equal(statements.filter(q => /select "c"\.\*/.test(q.sql)).length, 1);
    assert.match(statements.find(q => /select "c"\.\*/.test(q.sql)).sql, /limit \? offset \?/);
    const empty = await service.getListContacts('selected', { user_id: 'owner', company_id: 'company', page: 1000, limit: 20 });
    assert.equal(empty.contacts.length, 0); assert.equal(empty.total, 270);
    statements.length = 0;
    await service.getListContacts('selected', { assigned_user_id: 'member', page: 1, limit: 20 }).catch(error => {
      // SQLite does not implement PostgreSQL UUID-array assignment filtering.
      assert.match(error.message, /unrecognized token|syntax error/);
    });
    for (const query of statements) assert.match(query.sql, /c\.assigned_to @> ARRAY\[\?\]::uuid\[\]/);
    await assert.rejects(service.getListContacts('selected', { page: -1 }), /positive integers/);
  } finally { sqlite.close(); await db.destroy(); }
});

test('campaign targeting uses one scoped selection with list/tag subqueries and parameterized attributes', async () => {
  const db = knex({ client: 'pg' }), statements = [];
  db.client.runner = builder => ({ run: async () => { statements.push(builder.toSQL()); return []; } });
  class BaseModel { constructor(table) { this.db = db; this.tableName = table; } query() { return db(this.tableName); } }
  const model = load('src/app/models/contact.model.ts', { '@surefy/models/base.model': { BaseModel } });
  const service = load('src/app/services/contact.service.ts', {
    '../models/contact.model': model,
    '../models/contactListRelation.model': { getContactIdsByLists() { throw Error('Must not materialize list IDs'); } },
    '../models/contactTagRelation.model': { getContactIdsByTags() { throw Error('Must not materialize tag IDs'); } },
  });
  try {
    const key = "city' OR TRUE --";
    await service.getContactsByFilters('owner', 'company', { list_ids: ['list'], tag_ids: ['tag'],
      attributes: { [key]: 'Pune' }, contactNumber: ['+919372597458'] }, 'sender');
    assert.equal(statements.length, 1);
    const { sql, bindings } = statements[0];
    for (const predicate of ['"contacts"."user_id" = ?', '"contacts"."company_id" = ?', '"phone_number_id" = ?',
      '"deleted_at" is null', 'contact_list_relations', 'contact_tag_relations']) assert.ok(sql.includes(predicate), predicate);
    for (const value of ['owner', 'company', 'sender', 'list', 'tag', key, 'Pune']) assert.ok(bindings.includes(value), value);
    assert.equal((sql.match(/attributes->>/g) || []).length, 1); assert.ok(!sql.includes(key));
  } finally { await db.destroy(); }
});

test('sender lookups use the supplied transaction; batch lookups accept Meta IDs and UUIDs within the account', async () => {
  const db = knex({ client: 'pg' }), statements = [];
  db.client.runner = builder => ({ run: async () => { statements.push(builder.toSQL()); return []; } });
  class BaseModel { constructor(table) { this.db = db; this.tableName = table; } query() { throw Error('Transaction lookup must not acquire another pool connection'); } }
  const model = load('src/app/models/phoneNumber.model.ts', { '@surefy/models/base.model': { BaseModel }, uuid: require('uuid') });
  const id = '23860277-69cd-44c2-b557-08f00ecaf2cf';
  try {
    await model.findByPhoneNumberId(id, db);
    assert.match(statements[0].sql, /"phone_number_id" = \? or "id" = \?/);
    model.query = () => db('phone_numbers');
    await model.findOwnedByIdentifiers('owner', 'company', [id, '661886587013056', id, 'unknown']);
    const { sql, bindings } = statements[1];
    for (const fragment of ['"user_id" = ?', '"company_id" = ?', '"deleted_at" is null', '"phone_number_id" in', 'or "id" in']) assert.ok(sql.includes(fragment));
    assert.equal(bindings.filter(value => value === id).length, 2, 'UUID appears once as an external ID and once as a local ID');
    assert.ok(bindings.includes('owner') && bindings.includes('company'));
    await model.findOwnedByIdentifiers('owner', 'company', []); assert.equal(statements.length, 2);
  } finally { await db.destroy(); }
});

test('contact creation retains duplicate protection and uses one transaction for its phone lookup and insert', async () => {
  const calls = [], trx = table => {
    calls.push(['table', table]);
    return { where() { return this; }, whereNull() { return this; }, first: async () => undefined };
  };
  trx.raw = async () => { calls.push(['lock']); };
  class BaseModel {
    constructor(table) { this.tableName = table; this.db = () => { throw Error('Unexpected pool acquisition'); }; }
    async create(data, transaction) { assert.equal(transaction, trx); calls.push(['insert']); return { id: 'contact', ...data }; }
  }
  const model = load('src/app/models/contact.model.ts', {
    '@surefy/models/base.model': { BaseModel }, '../utils/importPhone': require('../src/app/utils/importPhone'),
    './phoneNumber.model': { findByPhoneNumberId: async (id, transaction) => {
      assert.equal(transaction, trx); calls.push(['sender', id]); return { id: 'sender', user_id: 'owner', company_id: 'company' };
    } },
  });
  const created = await model.create({ user_id: 'owner', company_id: 'company', phone_number_id: 'meta', phone_number: '+919372597458' }, trx);
  assert.equal(created.phone_number_id, 'sender'); assert.equal(created.country_code, '91');
  assert.deepEqual(calls, [['sender', 'meta'], ['lock'], ['table', 'contacts'], ['insert']]);
});

test('contact identity updates reuse the already-loaded contact while retaining normalization', async () => {
  class BaseModel { async update(id, data) { return { id, ...data }; } }
  const model = load('src/app/models/contact.model.ts', { '@surefy/models/base.model': { BaseModel },
    '../utils/importPhone': require('../src/app/utils/importPhone') });
  model.findById = async () => { throw Error('Must reuse current contact'); };
  const updated = await model.update('contact', { phone_number: '+6581234567' },
    { id: 'contact', phone_number: '+919372597458', country_code: '91' });
  assert.equal(updated.phone_number, '+6581234567'); assert.equal(updated.country_code, '65');
});

test('a 1000-message bulk request resolves distinct sender identifiers once and preserves its response', async () => {
  let userReads = 0, phoneReads = 0, queued = [], available = true;
  const id = '23860277-69cd-44c2-b557-08f00ecaf2cf', meta = '661886587013056';
  const service = load('src/app/services/message.service.ts', {
    uuid: require('uuid'), '../models/user.model': { findById: async () => { userReads++; return { company_id: 'company' }; } },
    '@surefy/console/models/phoneNumber.model': {
      findByPhoneNumberId() { throw Error('Must not look up a sender for every message'); },
      findOwnedByIdentifiers: async (owner, company, identifiers) => {
        phoneReads++; assert.equal(owner, 'owner'); assert.equal(company, 'company');
        assert.deepEqual(Array.from(identifiers), [meta, id]);
        return available ? [{ id, phone_number_id: meta }] : [];
      },
    },
    '../../queues/bulkMessageSend.queue': { bulkMessageSendQueue: { add: async (_name, data) => { queued.push(data); return { id: 'job' }; } } },
  });
  const messages = Array.from({ length: 1000 }, (_, i) => ({ phone_number_id: i % 2 ? id : meta, to: '+919372597458', type: 'text', text: { body: 'Hello' } }));
  const response = await service.bulkSendMessages('owner', messages);
  assert.equal(userReads, 1); assert.equal(phoneReads, 1); assert.equal(queued.length, 1);
  assert.equal(response.total_messages, 1000); assert.equal(response.messages.length, 1000); assert.equal(response.status, 'queued');
  assert.ok(queued[0].messages.every(row => row.user_id === 'owner' && row.company_id === 'company'));
  available = false;
  await assert.rejects(service.bulkSendMessages('owner', messages), /Phone number not found in your account/);
  assert.equal(queued.length, 1, 'unavailable senders must never enqueue');
  await assert.rejects(service.bulkSendMessages('owner', [null]), /Message at index 0/);
  assert.equal(phoneReads, 2, 'malformed messages must skip sender queries');
  await assert.rejects(service.bulkSendMessages('owner', Array(1001).fill(messages[0])), /Maximum 1000/);
  await assert.rejects(service.bulkSendMessages('owner', {}), /Messages array cannot be empty/);
  assert.equal(userReads, 2, 'malformed and oversized requests must skip database lookups');
});
