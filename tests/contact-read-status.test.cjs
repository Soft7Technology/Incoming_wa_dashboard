const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const knex = require('knex');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Optional on Node versions before 22. */ }

class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => deps[name] || {}, console: { log() {} } });
  return exports.default;
}
function fixture() {
  const db = knex({ client: 'pg' });
  const queries = [];
  class BaseModel {
    constructor(table) { this.table = table; }
    query() { return db(this.table); }
  }
  const model = load('src/app/models/contact.model.ts', {
    '@surefy/models/base.model': { BaseModel },
    '@surefy/exceptions/HTTP400Error': HttpError,
  });
  const contacts = [{ id: 'contact', user_id: 'owner', company_id: 'company', phone_number_id: 'sender' }];
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    queries.push(query);
    return /count\(/.test(query.sql) ? { count: '51' } : contacts;
  } });
  const service = load('src/app/services/contact.service.ts', {
    '../models/contact.model': model,
    '../models/phoneNumber.model': { findByPhoneNumberId: async () => ({
      id: 'sender', user_id: 'owner', company_id: 'company',
    }) },
    '../models/contactTagRelation.model': { getContactsWithTags: async () => [] },
    '../models/contactListRelation.model': { getContactIdsByLists: async () => ['contact'] },
    '../models/message.model': { findLatestForContacts: async () => [] },
    '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError,
  });
  return { db, model, service, queries, BaseModel };
}

test('read and unread select the latest message in either direction with full account and phone scope', async () => {
  const { db, model } = fixture();
  try {
    for (const read_status of ['read', 'unread']) {
      const { sql, bindings } = model.findWithFilters('owner', { read_status, onlyAssignedToUserId: 'member' }, 'sender').toSQL();
      assert.match(sql, /LIMIT 1\s+\) = \?/);
      for (const fragment of [
        'm.user_id = contacts.user_id', 'm.company_id = contacts.company_id',
        'm.phone_number_id = contacts.phone_number_id', "CASE WHEN m.direction = 'inbound'",
        "COALESCE(m.status = 'read', false) OR m.read_at IS NOT NULL",
        "regexp_replace(m.from_phone, '[^0-9]', '', 'g')", 'contacts.country_code || contacts.phone_number',
        "btrim(contacts.phone_number) LIKE '+%'", "btrim(contacts.phone_number) LIKE '00%'", 'ELSE NULL',
        '"contacts"."user_id" = ?', '"phone_number_id" = ?', '"deleted_at" is null', 'assigned_to @>',
      ]) assert.ok(sql.includes(fragment), fragment);
      assert.ok(sql.includes('m.to_phone') && !sql.includes('RIGHT('));
      assert.match(sql, /ORDER BY m.created_at DESC NULLS LAST, m.id DESC/);
      assert.deepEqual(bindings, ['sender', 'owner', 'member', read_status === 'read']);
    }
    const defaultSql = model.findWithFilters('owner', {}, 'sender').toSQL();
    const allSql = model.findWithFilters('owner', { read_status: 'all' }, 'sender').toSQL();
    assert.match(allSql.sql, /LIMIT 1\s+\) IS NOT NULL/);
    assert.deepEqual(allSql.bindings, defaultSql.bindings);
    assert.ok(!defaultSql.sql.includes('FROM messages'));
  } finally { await db.destroy(); }
});

test('read status filters both total and page while composing search, list and member filters', async () => {
  const { db, service, queries } = fixture();
  try {
    for (const read_status of ['read', 'unread']) {
      queries.length = 0;
      const result = await service.getContacts('owner', {
        page: 2, limit: 50, read_status, search: 'Parth', list_ids: ['list'], onlyAssignedToUserId: 'member',
      }, 'meta-sender', 'company');
      assert.equal(queries.length, 2);
      const [count, page] = queries;
      for (const query of queries) {
        assert.match(query.sql, /LIMIT 1\s+\) = \?/);
        assert.ok(query.bindings.includes(read_status === 'read'));
        for (const fragment of ['"contacts"."company_id" = ?', 'assigned_to @>', '"name" ilike', '"id" in (?)']) {
          assert.ok(query.sql.includes(fragment), fragment);
        }
        for (const value of ['owner', 'sender', 'company', 'member', '%Parth%', 'contact']) {
          assert.ok(query.bindings.includes(value), value);
        }
      }
      // first() limits the aggregate result to one row, never the counted contacts.
      assert.match(count.sql, /^select count\(\*\) as "count"/);
      assert.ok(!count.sql.includes('offset'));
      assert.equal(count.bindings.at(-1), 1);
      assert.match(page.sql, /limit \? offset \?/);
      assert.deepEqual(page.bindings.slice(-2), [50, 50]);
      assert.equal(result.pagination.total, 51);
      assert.equal(result.pagination.total_pages, 2);
      assert.equal(result.pagination.page, 2);
      assert.equal(result.contacts.length, 1);
    }
  } finally { await db.destroy(); }
});

test('read status works for unpaginated selection and rejects invalid query values', async () => {
  const { db, service, queries } = fixture();
  try {
    await service.getContacts('owner', { unpaginated: true, read_status: 'unread' }, 'sender', 'company');
    assert.ok(queries.every(query => /LIMIT 1\s+\) = \?/.test(query.sql)));
    assert.ok(!queries[1].sql.includes('limit ?') && !queries[1].sql.includes('offset'));
    queries.length = 0;
    for (const read_status of ['', 'READ', 'unknown', ['read', 'unread'], { value: 'read' }, null]) {
      await assert.rejects(service.getContacts('owner', { read_status }, 'sender', 'company'), /read_status must be all, read or unread/);
    }
    assert.equal(queries.length, 0);
  } finally { await db.destroy(); }
});

test('all excludes missing conversations from totals and sorts unread first before pagination', async () => {
  const { db, service, queries } = fixture();
  try {
    await service.getContacts('owner', { page: 2, limit: 50, read_status: 'all', sortBy: 'name', sortOrder: 'desc' },
      'meta-sender', 'company');
    assert.equal(queries.length, 2);
    const [count, page] = queries;
    for (const query of queries) assert.match(query.sql, /LIMIT 1\s+\) IS NOT NULL/);
    assert.match(count.sql, /^select count\(\*\) as "count"/);
    assert.ok(!count.sql.includes('ASC NULLS LAST'));
    assert.match(page.sql, /LIMIT 1\s+\) ASC NULLS LAST, "name" desc, "contacts"\."id" asc limit \? offset \?/);
    assert.deepEqual(page.bindings.slice(-2), [50, 50]);
  } finally { await db.destroy(); }
});

test('contact URL handlers forward read_status and retain team account scope', async () => {
  const calls = [];
  const controller = load('src/app/http/controllers/contact.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
    '@surefy/console/services/contact.service': { getContacts: async (...args) => { calls.push(args); return {}; } },
  });
  for (const read_status of ['all', 'read', 'unread']) {
    const req = { ownerId: 'owner', userId: 'member', companyId: 'company',
      params: { phoneNumberId: 'sender' }, query: { page: '1', limit: '50', read_status, phone_number_id: 'sender' } };
    await controller.getContactByPhoneNumberId(req, {});
    await controller.getContacts(req, {});
    await controller.getAllContacts(req, {});
  }
  assert.equal(calls.length, 9);
  for (const [index, [owner, filters, sender, company]] of calls.entries()) {
    assert.equal(owner, 'owner');
    assert.equal(sender, 'sender');
    assert.equal(company, 'company');
    assert.equal(filters.onlyAssignedToUserId, 'member');
    assert.equal(filters.read_status, ['all', 'read', 'unread'][Math.floor(index / 3)]);
    assert.equal(filters.page, '1');
    assert.equal(filters.limit, '50');
  }
});

test('latest message controls membership and marking it read moves the contact between tabs', { skip: !DatabaseSync }, async () => {
  const { db, model, BaseModel } = fixture();
  const memory = new DatabaseSync(':memory:');
  // Run the generated SQL locally with the PostgreSQL string functions it uses.
  memory.function('btrim', value => value == null ? null : value.trim());
  memory.function('regexp_replace', (value, pattern, replacement, flags) =>
    value == null ? null : value.replace(new RegExp(pattern, flags), replacement));
  memory.exec(`CREATE TABLE contacts (id TEXT, user_id TEXT, company_id TEXT, phone_number_id TEXT,
    phone_number TEXT, country_code TEXT, deleted_at TEXT);
    CREATE TABLE messages (id TEXT, wamid TEXT, user_id TEXT, company_id TEXT, phone_number_id TEXT,
    direction TEXT, from_phone TEXT, to_phone TEXT, status TEXT, read_at TEXT, created_at TEXT, updated_at TEXT);`);
  const contact = memory.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, NULL)');
  for (const [id, phone, code] of [
    ['latest-read', '+919372597458', '91'], ['latest-unread', '9372597459', '91'],
    ['outbound-read', '00919372597460', '91'], ['outbound-unread', '+919372597461', '91'],
    ['no-history', '+919372597462', '91'], ['timestamp-read', '+919372597463', '91'],
    ['null-status', '+919372597464', '91'], ['other-country', '9372597459', '1'],
  ]) contact.run(id, 'owner', 'company', 'sender', phone, code);
  const message = memory.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)');
  const addMessage = (id, recipient, status, at, direction = 'inbound', readAt = null, scope = {}) =>
    message.run(id, id, scope.user || 'owner', scope.company || 'company', scope.sender || 'sender',
      direction, direction === 'inbound' ? recipient : 'business', direction === 'outbound' ? recipient : 'business',
      status, readAt, at);
  addMessage('01', '919372597458', 'received', '2026-10-01');
  addMessage('02', '919372597458', 'read', '2026-10-02');
  addMessage('03', '919372597459', 'read', '2026-10-01');
  addMessage('04', '919372597459', 'received', '2026-10-02');
  addMessage('05', '919372597460', 'read', '2026-10-02', 'outbound');
  addMessage('06', '919372597461', 'read', '2026-10-01');
  addMessage('07', '919372597461', 'delivered', '2026-10-02', 'outbound');
  addMessage('08', '919372597463', 'delivered', '2026-10-02', 'outbound', '2026-10-03');
  addMessage('09', '919372597464', null, '2026-10-02');
  for (const [index, scope] of [{ user: 'other' }, { company: 'other' }, { sender: 'other' }].entries()) {
    addMessage(`foreign-${index}`, '919372597459', 'read', '2026-10-04', 'inbound', null, scope);
  }
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    const bindings = query.bindings.map(value => typeof value === 'boolean' ? Number(value)
      : value && typeof value.toISOString === 'function' ? value.toISOString() : value);
    const statement = memory.prepare(query.sql);
    return query.method === 'first' ? statement.get(...bindings) : statement.all(...bindings);
  } });
  const ids = async read_status => (await model.findWithFilters('owner', { read_status }, 'sender')
    .where('contacts.company_id', 'company').orderBy('contacts.id')).map(row => row.id);
  try {
    assert.deepEqual(await ids('read'), ['latest-read', 'outbound-read', 'timestamp-read']);
    assert.deepEqual(await ids('unread'), ['latest-unread', 'null-status', 'outbound-unread']);
    assert.equal((await ids('all')).length, 6);
    const combined = () => model.orderByReadStatus(model.findWithFilters('owner', { read_status: 'all' }, 'sender')
      .where('contacts.company_id', 'company')).orderBy('contacts.id');
    assert.deepEqual((await combined().limit(3).offset(0)).map(row => row.id),
      ['latest-unread', 'null-status', 'outbound-unread']);
    assert.deepEqual((await combined().limit(3).offset(3)).map(row => row.id),
      ['latest-read', 'outbound-read', 'timestamp-read']);
    const messageModel = load('src/app/models/message.model.ts', { '@surefy/models/base.model': { BaseModel } });
    const receipts = [];
    const messageService = load('src/app/services/message.service.ts', {
      '@surefy/console/models/message.model': messageModel,
      '@surefy/console/models/phoneNumber.model': { findByPhoneNumberId: async () => ({ phone_number_id: 'meta-sender' }) },
      '@surefy/console/services/meta.service': { markAsRead: async (...args) => receipts.push(args) },
    });
    // Reading an older message must not override the latest received message.
    await messageService.markAsRead({ phone_number_id: 'sender', message_id: '03' });
    assert.ok((await ids('unread')).includes('latest-unread'));
    await messageService.markAsRead({ phone_number_id: 'sender', message_id: '04' });
    assert.deepEqual(receipts.at(-1), ['meta-sender', '04']);
    const saved = memory.prepare("SELECT status, read_at FROM messages WHERE id = '04'").get();
    assert.equal(saved.status, 'read');
    assert.ok(saved.read_at);
    assert.ok((await ids('read')).includes('latest-unread'));
    assert.ok(!(await ids('unread')).includes('latest-unread'));
    assert.deepEqual((await combined().limit(2)).map(row => row.id), ['null-status', 'outbound-unread']);
    // A new customer message makes the conversation unread again.
    addMessage('10', '919372597459', 'received', '2026-10-05');
    assert.ok((await ids('unread')).includes('latest-unread'));
  } finally { memory.close(); await db.destroy(); }
});
