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
  vm.runInNewContext(code, { exports, require: name => deps[name] || {}, console: { log() {}, warn() {} } });
  return exports.default ?? exports;
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
    assert.equal(queries.length, 1, 'unpaginated selection does not need a separate count');
    assert.ok(!queries[0].sql.includes('limit ?') && !queries[0].sql.includes('offset'));
    queries.length = 0;
    for (const read_status of ['', 'READ', 'unknown', ['read', 'unread'], { value: 'read' }, null]) {
      await assert.rejects(service.getContacts('owner', { read_status }, 'sender', 'company'), /read_status must be all, read or unread/);
    }
    assert.equal(queries.length, 0);
  } finally { await db.destroy(); }
});

test('contact stage status filters totals and rows on both global and sender-specific listings', async () => {
  const { db, service, model, queries } = fixture();
  const status = '6ddf72ae-bae1-49f6-9013-1f0a6ee10871';
  try {
    for (const sender of [undefined, 'meta-sender']) {
      for (const read_status of [undefined, 'all', 'read', 'unread']) {
        queries.length = 0;
        await service.getContacts('owner', { status, read_status, page: 2, limit: 10,
          sortBy: 'created_at', sortOrder: 'desc', search: 'Customer', list_ids: ['list'],
          onlyAssignedToUserId: 'member' }, sender, 'company');
        assert.equal(queries.length, 2);
        for (const query of queries) {
          assert.match(query.sql, /"contacts"\."status" = \?/);
          assert.equal(query.bindings.filter(value => value === status).length, 1);
          assert.match(query.sql, /"contacts"\."user_id" = \?/);
          assert.match(query.sql, /"contacts"\."company_id" = \?/);
          assert.match(query.sql, /assigned_to @>/);
          assert.match(query.sql, /"deleted_at" is null/);
          assert.match(query.sql, /"name" ilike/);
          assert.match(query.sql, /"id" in \(\?\)/);
          assert.equal(query.bindings.includes('sender'), Boolean(sender));
        }
        assert.match(queries[0].sql, /^select count\(\*\)/);
        assert.match(queries[1].sql, /"created_at" desc, "contacts"\."id" asc limit \? offset \?/);
        assert.deepEqual(queries[1].bindings.slice(-2), [10, 10]);
      }
    }
    assert.ok(!model.findWithFilters('owner').toSQL().sql.includes('"contacts"."status"'));
    queries.length = 0;
    for (const status of ['', 'all', 'read', 'not-a-uuid', null, {}, ['6ddf72ae-bae1-49f6-9013-1f0a6ee10871']]) {
      await assert.rejects(service.getContacts('owner', { status }, undefined, 'company'), /status must be a contact stage UUID/);
    }
    assert.equal(queries.length, 0);
  } finally { await db.destroy(); }
});

test('status filtering paginates only matching contacts and composes with inbox state using indexed queries',
  { skip: !DatabaseSync }, async () => {
    const { db, model, service } = fixture();
    const memory = new DatabaseSync(':memory:');
    memory.function('btrim', value => value == null ? null : value.trim());
    memory.function('regexp_replace', (value, pattern, replacement, flags) =>
      value == null ? null : value.replace(new RegExp(pattern, flags), replacement));
    const status = '6ddf72ae-bae1-49f6-9013-1f0a6ee10871';
    const otherStatus = '1308d117-f311-4a0d-8246-a47de193d8df';
    memory.exec(`CREATE TABLE contacts (id TEXT, user_id TEXT, company_id TEXT, phone_number_id TEXT,
      phone_number TEXT, country_code TEXT, status TEXT, created_at TEXT, deleted_at TEXT);
      CREATE TABLE messages (id TEXT, user_id TEXT, company_id TEXT, phone_number_id TEXT,
      direction TEXT, from_phone TEXT, to_phone TEXT, status TEXT, read_at TEXT, inbox_read_at TEXT, created_at TEXT);`);
    try {
      const insert = memory.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 20; i++) insert.run(String(i).padStart(2, '0'), 'owner', 'company', 'sender',
        `+9190000000${String(i).padStart(2, '0')}`, '91', i < 15 ? status : otherStatus, '2026-10-08', null);
      insert.run('50', 'owner', 'company', 'other-phone', '+919000000050', '91', status, '2026-10-08', null);
      insert.run('no-stage', 'owner', 'company', 'sender', '+919000000060', '91', null, '2026-10-08', null);
      insert.run('foreign-owner', 'other', 'company', 'sender', '+919000000061', '91', status, '2026-10-08', null);
      insert.run('foreign-company', 'owner', 'other', 'sender', '+919000000062', '91', status, '2026-10-08', null);
      insert.run('deleted', 'owner', 'company', 'sender', '+919000000063', '91', status, '2026-10-08', '2026-10-08');
      memory.exec(`INSERT INTO messages VALUES ('incoming-0', 'owner', 'company', 'sender', 'inbound',
        '919000000000', 'business', 'received', NULL, NULL, '2026-10-08');
        INSERT INTO messages VALUES ('incoming-1', 'owner', 'company', 'sender', 'inbound',
        '919000000001', 'business', 'received', NULL, '2026-10-08', '2026-10-08');`);
      db.client.runner = builder => ({ run: async () => {
        const query = builder.toSQL();
        const statement = memory.prepare(query.sql);
        const values = query.bindings.map(value => typeof value === 'boolean' ? Number(value) : value);
        return query.method === 'first' ? statement.get(...values) : statement.all(...values);
      } });
      const first = await service.getContacts('owner', { status, page: 1, limit: 10 }, undefined, 'company');
      const second = await service.getContacts('owner', { status, page: 2, limit: 10 }, undefined, 'company');
      assert.equal(first.pagination.total, 16);
      assert.equal(first.pagination.total_pages, 2);
      assert.deepEqual(first.contacts.map(row => row.id), Array.from({ length: 10 }, (_, i) => String(i).padStart(2, '0')));
      assert.deepEqual(second.contacts.map(row => row.id), ['10', '11', '12', '13', '14', '50']);
      assert.ok([...first.contacts, ...second.contacts].every(row => row.status === status));
      // These matches all fall beyond the first unfiltered page. Filtering a
      // fetched page in JavaScript would return empty or incomplete pages.
      const matchingPages = [];
      for (const senderId of [undefined, 'sender']) {
        for (let page = 1; page <= 3; page++) {
          const result = await service.getContacts('owner', {
            status: otherStatus, page: String(page), limit: '2', sortBy: 'created_at', sortOrder: 'desc',
          }, senderId, 'company');
          assert.deepEqual({ ...result.pagination }, { total: 5, page, limit: 2, total_pages: 3 });
          const expected = [['15', '16'], ['17', '18'], ['19']][page - 1];
          assert.deepEqual(result.contacts.map(row => row.id), expected);
          assert.ok(result.contacts.every(row => row.status === otherStatus));
          if (senderId === undefined) matchingPages.push(...result.contacts.map(row => row.id));
        }
      }
      assert.equal(new Set(matchingPages).size, 5, 'no duplicates across filtered pages with tied sort values');
      const outside = await service.getContacts('owner', { status: otherStatus, page: 4, limit: 2 }, undefined, 'company');
      assert.equal(outside.contacts.length, 0);
      assert.deepEqual({ ...outside.pagination }, { total: 5, page: 4, limit: 2, total_pages: 3 });
      const sender = await service.getContacts('owner', { status, unpaginated: true }, 'sender', 'company');
      assert.equal(sender.total, 15);
      const read = await service.getContacts('owner', { status, read_status: 'read' }, 'sender', 'company');
      const unread = await service.getContacts('owner', { status, read_status: 'unread' }, 'sender', 'company');
      const all = await service.getContacts('owner', { status, read_status: 'all' }, 'sender', 'company');
      assert.deepEqual(read.contacts.map(row => row.id), ['01']);
      assert.deepEqual(unread.contacts.map(row => row.id), ['00']);
      assert.deepEqual(all.contacts.map(row => row.id), ['00', '01']);
      const missing = await service.getContacts('owner', { status: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, undefined, 'company');
      assert.equal(missing.pagination.total, 0);
      assert.equal(missing.contacts.length, 0);

      const migration = load('src/database/migrations/20261008000003_index_contact_status_queries.ts', {});
      assert.equal(migration.config.transaction, false);
      await migration.up({ raw: async sql => memory.exec(sql.replace(/ CONCURRENTLY/g, '')) });
      for (const phone of [undefined, 'sender']) {
        const query = model.findWithFilters('owner', { status }, phone).where('contacts.company_id', 'company')
          .orderBy('contacts.created_at', 'desc').orderBy('contacts.id', 'asc').limit(10).toSQL();
        const plan = memory.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings);
        assert.ok(plan.some(row => /SEARCH contacts USING INDEX contacts_(account|phone)_status_created_idx/.test(row.detail)));
        assert.ok(!plan.some(row => /TEMP B-TREE/.test(row.detail)));
      }
      await migration.down({ raw: async sql => memory.exec(sql.replace(/ CONCURRENTLY/g, '')) });
    } finally { memory.close(); await db.destroy(); }
  });

test('conversation indexes avoid scanning message history for every contact without changing filter results',
  { skip: !DatabaseSync }, async () => {
    const { db, model } = fixture();
    const memory = new DatabaseSync(':memory:');
    let normalizations = 0;
    memory.function('btrim', { deterministic: true }, value => value == null ? null : value.trim());
    memory.function('regexp_replace', { deterministic: true }, (value, pattern, replacement, flags) => {
      normalizations++;
      return value == null ? null : value.replace(new RegExp(pattern, flags), replacement);
    });
    memory.exec(`CREATE TABLE contacts (id TEXT, user_id TEXT, company_id TEXT, phone_number_id TEXT,
      phone_number TEXT, country_code TEXT, deleted_at TEXT, created_at TEXT);
      CREATE TABLE messages (id TEXT, user_id TEXT, company_id TEXT, phone_number_id TEXT,
      direction TEXT, from_phone TEXT, to_phone TEXT, status TEXT, read_at TEXT, inbox_read_at TEXT, created_at TEXT);`);
    try {
      const contact = memory.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, NULL, ?)');
      const message = memory.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)');
      memory.exec('BEGIN');
      for (let c = 0; c < 40; c++) {
        const recipient = `9190000000${String(c).padStart(2, '0')}`;
        contact.run(String(c).padStart(2, '0'), 'owner', 'company', 'sender', `+${recipient}`, '91', String(c));
        for (let m = 0; m < 100; m++) {
          const direction = m % 2 ? 'outbound' : 'inbound';
          message.run(`${c}-${String(m).padStart(3, '0')}`, 'owner', 'company', 'sender', direction,
            direction === 'inbound' ? recipient : 'business', direction === 'outbound' ? recipient : 'business',
            c % 2 ? 'read' : 'delivered', String(m).padStart(3, '0'));
        }
      }
      memory.exec('COMMIT');
      const queries = ['all', 'read', 'unread'].map(read_status => {
        const query = model.findWithFilters('owner', { read_status }, 'sender')
          .where('contacts.company_id', 'company');
        if (read_status === 'all') model.orderByReadStatus(query);
        return query.orderBy('contacts.created_at', 'desc').orderBy('contacts.id').limit(10).toSQL();
      });
      const run = query => memory.prepare(query.sql)
        .all(...query.bindings.map(value => typeof value === 'boolean' ? Number(value) : value)).map(row => row.id);
      normalizations = 0;
      const before = queries.map(run);
      const beforeWork = normalizations;
      const migration = load('src/database/migrations/20261008000002_index_contact_inbox_queries.ts', {});
      assert.equal(migration.config.transaction, false);
      const indexSql = [];
      await migration.up({ raw: async sql => {
        indexSql.push(sql);
        // SQLite exercises the same expression index and queries locally. PostgreSQL-specific
        // concurrent creation and covering columns do not change the indexed expression.
        memory.exec(sql.replace(/ CONCURRENTLY/g, '').replace(/ NULLS LAST/g, '')
          .replace(/\s+INCLUDE \([^)]*\)/g, ''));
      } });
      assert.match(indexSql[0], /INCLUDE \(direction, status, read_at, inbox_read_at\)/);
      normalizations = 0;
      assert.deepEqual(queries.map(run), before);
      assert.ok(normalizations < beforeWork / 10,
        `expected indexed lookups: ${normalizations} normalizations instead of ${beforeWork}`);
      for (const query of queries) {
        const plan = memory.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
          .all(...query.bindings.map(value => typeof value === 'boolean' ? Number(value) : value));
        assert.ok(plan.some(row => /SEARCH m USING INDEX messages_inbox_conversation_idx/.test(row.detail)));
        assert.ok(!plan.some(row => /SCAN m\b/.test(row.detail)));
      }
      await migration.down({ raw: async sql => memory.exec(sql.replace(/ CONCURRENTLY/g, '')) });
    } finally { memory.close(); await db.destroy(); }
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
      params: { phoneNumberId: 'sender' }, query: { page: '1', limit: '50', read_status, phone_number_id: 'sender',
        status: '6ddf72ae-bae1-49f6-9013-1f0a6ee10871' } };
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
    assert.equal(filters.status, '6ddf72ae-bae1-49f6-9013-1f0a6ee10871');
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
    direction TEXT, from_phone TEXT, to_phone TEXT, status TEXT, read_at TEXT, created_at TEXT, updated_at TEXT,
    inbox_read_at TEXT);`);
  const contact = memory.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, NULL)');
  for (const [id, phone, code] of [
    ['latest-read', '+919372597458', '91'], ['latest-unread', '9372597459', '91'],
    ['outbound-read', '00919372597460', '91'], ['outbound-unread', '+919372597461', '91'],
    ['no-history', '+919372597462', '91'], ['timestamp-read', '+919372597463', '91'],
    ['null-status', '+919372597464', '91'], ['other-country', '9372597459', '1'],
  ]) contact.run(id, 'owner', 'company', 'sender', phone, code);
  const message = memory.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)');
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
      '@surefy/console/models/phoneNumber.model': { findByPhoneNumberId: async () => ({
        id: 'sender', user_id: 'owner', company_id: 'company', phone_number_id: 'meta-sender',
      }) },
      '@surefy/console/services/meta.service': { markAsRead: async (...args) => receipts.push(args) },
      '@surefy/exceptions/HTTP400Error': HttpError,
      '@surefy/exceptions/HTTP404Error': HttpError,
    });
    const mark = message_id => messageService.markAsRead({ user_id: 'owner', company_id: 'company',
      phone_number_id: 'sender', message_id });
    // Reading an older message must not override the latest received message.
    await mark('03');
    assert.ok((await ids('unread')).includes('latest-unread'));
    await mark('04');
    assert.deepEqual(receipts.at(-1), ['meta-sender', '04']);
    const saved = memory.prepare("SELECT status, read_at, inbox_read_at FROM messages WHERE id = '04'").get();
    assert.equal(saved.status, 'received');
    assert.equal(saved.read_at, null);
    assert.ok(saved.inbox_read_at);
    assert.ok((await ids('read')).includes('latest-unread'));
    assert.ok(!(await ids('unread')).includes('latest-unread'));
    assert.deepEqual((await combined().limit(2)).map(row => row.id), ['null-status', 'outbound-unread']);
    // A new customer message makes the conversation unread again.
    addMessage('10', '919372597459', 'received', '2026-10-05');
    assert.ok((await ids('unread')).includes('latest-unread'));
    // Viewing an outbound message moves the chat without changing customer receipts.
    const receiptCount = receipts.length;
    const result = await mark('07');
    assert.equal(result.updated_count, 2);
    assert.equal(result.read_receipt_sent, false);
    assert.equal(receipts.length, receiptCount);
    assert.ok((await ids('read')).includes('outbound-unread'));
    assert.equal(memory.prepare("SELECT status FROM messages WHERE id = '07'").get().status, 'delivered');
    // Idempotent calls and later delivery updates must not undo the saved view.
    assert.equal((await mark('07')).updated_count, 0);
    memory.exec("UPDATE messages SET status = 'delivered' WHERE id = '07'");
    assert.ok((await ids('read')).includes('outbound-unread'));
    // Messages arriving after the selected snapshot remain unread, including microsecond differences.
    const snapshot = await messageModel.findForInboxRead({ user_id: 'owner', company_id: 'company',
      phone_number_id: 'sender' }, { identifier: '10' });
    addMessage('11', '919372597459', 'received', '2026-10-05T01:00:00.123001Z');
    await messageModel.markInboxReadThrough(snapshot);
    assert.equal(memory.prepare("SELECT inbox_read_at FROM messages WHERE id = '11'").get().inbox_read_at, null);
    const preciseSnapshot = await messageModel.findForInboxRead({ user_id: 'owner', company_id: 'company',
      phone_number_id: 'sender' }, { identifier: '11' });
    addMessage('12', '919372597459', 'received', '2026-10-05T01:00:00.123002Z');
    await messageModel.markInboxReadThrough(preciseSnapshot);
    assert.ok((await ids('unread')).includes('latest-unread'));
    assert.equal(memory.prepare("SELECT inbox_read_at FROM messages WHERE id = '12'").get().inbox_read_at, null);
    for (const row of memory.prepare("SELECT inbox_read_at FROM messages WHERE id LIKE 'foreign-%'").all()) {
      assert.equal(row.inbox_read_at, null);
    }
    // The database UUID exposed by last_message works as well as the WhatsApp ID.
    const databaseId = 'dcdb7ace-3431-415b-a9b1-5f986225bda0';
    addMessage(databaseId, '919372597461', 'failed', '2026-10-06', 'outbound');
    memory.prepare('UPDATE messages SET wamid = ? WHERE id = ?').run('wamid.failed', databaseId);
    assert.ok((await ids('unread')).includes('outbound-unread'));
    await mark(databaseId);
    assert.ok((await ids('read')).includes('outbound-unread'));
    assert.equal(memory.prepare('SELECT status FROM messages WHERE id = ?').get(databaseId).status, 'failed');
    assert.equal(receipts.length, receiptCount);
    await assert.rejects(mark('unknown-wamid'), /Message not found/);
    await assert.rejects(mark('foreign-0'), /Message not found/);
    await assert.rejects(mark('foreign-1'), /Message not found/);
    await assert.rejects(mark('foreign-2'), /Message not found/);
  } finally { memory.close(); await db.destroy(); }
});
