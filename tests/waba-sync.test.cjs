const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({ message }) { super(message); } }
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, Date, process: { env: {} }, console: { log() {}, error() {} },
    require: name => deps[name] || (name.includes('Error') ? HttpError : {}) });
  return exports.default;
}
const account = { id: '8c23c966-b4ee-4c8a-bb8b-644102929b5e', waba_id: '123456',
  user_id: 'owner', company_id: 'company', name: 'Old name', currency: 'USD', meta_data: { retained: true } };
const phone = (id, changes = {}) => ({ id, display_phone_number: '+1 555 1234567',
  verified_name: 'New name', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', ...changes });
function serviceFixture({ waba = account, details = { id: account.waba_id, name: 'New account' },
  phones = [phone('1001')], remoteError } = {}) {
  const calls = [], writes = [];
  const service = load('src/app/services/waba.service.ts', {
    uuid: require('uuid'),
    '@surefy/console/models/waba.model': {
      findOwnedForSync: async (...args) => { calls.push(['lookup', ...args]); return waba; },
      syncAccountAndPhones: async (...args) => { writes.push(args); return { phone_numbers: args[2] }; },
    },
    '@surefy/console/services/meta.service': {
      getWabaDetails: async id => { calls.push(['details', id]); if (remoteError) throw remoteError; return details; },
      getPhoneNumbers: async id => { calls.push(['phones', id]); return { data: phones }; },
    },
  });
  return { service, calls, writes };
}

test('sync accepts Meta and local WABA IDs, deduplicates phones and fetches using the Meta ID', async () => {
  for (const id of [account.waba_id, account.id]) {
    const f = serviceFixture({ phones: [phone('1001'), phone('1001'), phone('1002')] });
    const result = await f.service.syncWaba('owner', 'company', id);
    assert.deepEqual(f.calls, [['lookup', id, 'owner', 'company'], ['details', account.waba_id], ['phones', account.waba_id]]);
    assert.deepEqual(Array.from(result.phone_numbers, p => p.id), ['1001', '1002']);
    assert.equal(f.writes.length, 1);
  }
});

test('sync rejects invalid IDs or missing context without database or Meta calls', async () => {
  for (const id of ['', 'not-an-id', {}, 123456, '123/phone_numbers', '1'.repeat(256)]) {
    const f = serviceFixture();
    await assert.rejects(f.service.syncWaba('owner', 'company', id), /wabaId must/);
    assert.equal(f.calls.length, 0);
  }
  const f = serviceFixture();
  await assert.rejects(f.service.syncWaba('', 'company', account.waba_id), /context/);
  assert.equal(f.calls.length, 0);
});

test('missing, deleted or foreign WABAs fail before remote reads or writes', async () => {
  for (const waba of [null, { ...account, deleted_at: new Date() },
    { ...account, user_id: 'other' }, { ...account, company_id: 'other' }]) {
    const f = serviceFixture({ waba });
    await assert.rejects(f.service.syncWaba('owner', 'company', account.waba_id), /not found in your account/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.writes.length, 0);
  }
});

test('remote failures and malformed snapshots cannot persist a partial account', async () => {
  for (const options of [{ remoteError: Error('Meta unavailable') }, { details: { id: 'wrong' } },
    { phones: null }, { phones: [phone('bad-id')] }, { phones: [phone('1001', { display_phone_number: '' })] }]) {
    const f = serviceFixture(options);
    await assert.rejects(f.service.syncWaba('owner', 'company', account.waba_id));
    assert.equal(f.writes.length, 0);
  }
});

test('legacy phone sync returns all refreshed phone rows and uses the authenticated owner', async () => {
  const f = serviceFixture();
  assert.equal((await f.service.syncPhoneNumbers('company', account.id, 'owner')).length, 1);
  assert.deepEqual(f.calls[0], ['lookup', account.id, 'owner', 'company']);
});

function metaFixture(pages) {
  const calls = [];
  const service = load('src/app/services/meta.service.ts', { axios: { create: () => ({
    get: async (path, config) => {
      calls.push({ path, config });
      const page = pages[calls.length - 1];
      if (page instanceof Error) throw page;
      return { data: page };
    },
  }) } });
  return { service, calls };
}

test('Meta phone listing follows every cursor on the original endpoint', async () => {
  const f = metaFixture([
    { data: [phone('1001')], paging: { next: 'https://untrusted.example/ignored', cursors: { after: 'page2' } } },
    { data: [phone('1002')], paging: { cursors: { after: 'unused-final-cursor' } } },
  ]);
  const result = await f.service.getPhoneNumbers(account.waba_id);
  assert.deepEqual(Array.from(result.data, p => p.id), ['1001', '1002']);
  assert.equal(f.calls[1].path, '/123456/phone_numbers');
  assert.equal(f.calls[1].config.params.after, 'page2');
  assert.match(f.calls[0].config.params.fields, /code_verification_status/);
});

test('Meta pagination rejects missing/repeated/cyclic cursors and later-page failures', async () => {
  const page = after => ({ data: [], paging: { next: 'next', cursors: { after } } });
  for (const pages of [[page(undefined)], [page('a'), page('a')], [page('a'), page('b'), page('a')],
    [page('a'), Error('second page failed')], [{ data: {} }]]) {
    const f = metaFixture(pages);
    await assert.rejects(f.service.getPhoneNumbers(account.waba_id), /Failed to fetch phone numbers/);
  }
  assert.deepEqual(Array.from((await metaFixture([{ data: [] }]).service.getPhoneNumbers(account.waba_id)).data), []);
});

// Transaction simulation checks rollback and identity preservation; SQL compilation is checked separately below.
function persistenceFixture({ phones = [], failBatch = 0, race = false, missingAccount = false } = {}) {
  let state = { account: { ...account }, phones: structuredClone(phones) };
  const batches = [], lookups = [];
  const query = (table, draft) => {
    let filters = [], first = false, operation, values, mergeColumns;
    const q = {
      where(conditions) { lookups.push(conditions); filters.push(row => Object.entries(conditions)
        .every(([key, value]) => row[key.split('.').at(-1)] === value)); return q; },
      whereNull(key) { filters.push(row => row[key] == null); return q; },
      whereIn(key, ids) { filters.push(row => ids.includes(row[key])); return q; },
      forUpdate() { return q; }, first() { first = true; return q; },
      update(data) { operation = 'update'; values = data; return q; },
      insert(data) { operation = 'insert'; values = data; return q; },
      onConflict() { return q; }, merge(columns) { mergeColumns = columns; return q; }, returning() { return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        const matches = row => filters.every(filter => filter(row));
        const rows = table === 'waba_accounts' ? (missingAccount ? [] : [draft.account]) : draft.phones;
        let result = rows.filter(matches);
        if (operation === 'update') result.forEach(row => Object.assign(row, values));
        if (operation === 'insert') {
          batches.push(values.length);
          if (failBatch === batches.length) throw Error('phone write failed');
          result = [];
          for (const value of values) {
            let existing = draft.phones.find(p => p.phone_number_id === value.phone_number_id);
            if (race || (existing && !matches(existing))) continue;
            if (existing) Object.assign(existing, Object.fromEntries(mergeColumns.map(key => [key, value[key]])));
            else { existing = { ...value, id: `new-${value.phone_number_id}`, status: 'active' }; draft.phones.push(existing); }
            result.push(existing);
          }
        }
        return first ? result[0] : result;
      }).then(resolve, reject); },
    };
    return q;
  };
  const db = table => query(table, state);
  db.transaction = async callback => {
    const draft = structuredClone(state);
    const result = await callback(table => query(table, draft));
    state = draft;
    return result;
  };
  class BaseModel { constructor() { this.db = db; } query() { return db('waba_accounts'); } }
  return { model: load('src/app/models/waba.model.ts', { '@surefy/models/base.model': { BaseModel } }),
    state: () => state, batches, lookups };
}
const savedPhone = (id, changes = {}) => ({ id: `local-${id}`, phone_number_id: id,
  user_id: account.user_id, company_id: account.company_id, waba_id: account.id,
  display_phone_number: 'Old number', verified_name: 'Old name', status: 'inactive', ...changes });

test('sync refreshes existing phones, adds new phones and preserves local UUIDs and status on repeat calls', async () => {
  const f = persistenceFixture({ phones: [savedPhone('1001', { deleted_at: '2026-01-01' }), savedPhone('9999')] });
  const details = { id: account.waba_id, name: 'New WABA', message_template_namespace: 'namespace' };
  const phones = [phone('1001'), phone('1002')];
  const result = await f.model.syncAccountAndPhones(account, details, phones);
  assert.equal(result.waba.name, 'New WABA');
  assert.equal(result.waba.message_template_namespace, 'namespace');
  assert.equal(JSON.parse(result.waba.meta_data).retained, true);
  assert.equal(result.created, 1); assert.equal(result.updated, 1);
  const updated = result.phone_numbers.find(p => p.phone_number_id === '1001');
  assert.equal(updated.id, 'local-1001'); assert.equal(updated.status, 'inactive');
  assert.equal(updated.display_phone_number, phones[0].display_phone_number);
  assert.equal(updated.verified_name, 'New name'); assert.equal(updated.quality_rating, 'GREEN');
  assert.equal(updated.code_verification_status, 'VERIFIED'); assert.equal(updated.deleted_at, null);
  assert.equal(f.state().phones.length, 3, 'numbers absent from Meta are retained');
  const repeat = await f.model.syncAccountAndPhones(account, details, phones);
  assert.equal(repeat.created, 0); assert.equal(repeat.updated, 2);
  assert.equal(f.state().phones.length, 3);
});

test('foreign phone ownership or a concurrent number conflict rolls back the whole sync', async () => {
  for (const changes of [{ user_id: 'other' }, { company_id: 'other' }, { waba_id: 'other' }]) {
    const f = persistenceFixture({ phones: [savedPhone('1001', changes)] });
    const before = structuredClone(f.state());
    await assert.rejects(f.model.syncAccountAndPhones(account, { name: 'Changed' }, [phone('1001')]), /another account or WABA/);
    assert.deepEqual(f.state(), before);
  }
  const f = persistenceFixture({ race: true });
  await assert.rejects(f.model.syncAccountAndPhones(account, { name: 'Changed' }, [phone('1001')]), /another account or WABA/);
  assert.equal(f.state().account.name, account.name);
});

test('phone batches are bounded and a later batch failure rolls back account and earlier phone writes', async () => {
  const phones = Array.from({ length: 201 }, (_, i) => phone(String(1000 + i)));
  const f = persistenceFixture();
  await f.model.syncAccountAndPhones(account, { name: 'Changed' }, phones);
  assert.deepEqual(f.batches, [200, 1]);
  const failure = persistenceFixture({ failBatch: 2 });
  await assert.rejects(failure.model.syncAccountAndPhones(account, { name: 'Changed' }, phones), /phone write failed/);
  assert.equal(failure.state().account.name, account.name);
  assert.equal(failure.state().phones.length, 0);
});

test('empty Meta phone list refreshes the account and a deleted account cannot be synced', async () => {
  const f = persistenceFixture({ phones: [savedPhone('1001')] });
  const result = await f.model.syncAccountAndPhones(account, { name: 'Changed' }, []);
  assert.equal(result.total_phone_numbers, 0); assert.equal(f.state().phones.length, 1);
  const missing = persistenceFixture({ missingAccount: true });
  await assert.rejects(missing.model.syncAccountAndPhones(account, {}, []), /not found in your account/);
});

test('identifier lookups and conflict SQL retain owner/company/WABA scope without merging local UUIDs', async () => {
  const db = require('knex')({ client: 'pg' });
  const statements = [];
  const connection = table => db(table);
  connection.transaction = async callback => callback(db);
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL(); statements.push(query);
    if (query.method === 'first') return { ...account };
    if (query.method === 'select') return [];
    if (query.method === 'update') return [{ ...account }];
    return [{ ...savedPhone('1001') }];
  } });
  class BaseModel { constructor() { this.db = connection; } query() { return db('waba_accounts'); } }
  const model = load('src/app/models/waba.model.ts', { '@surefy/models/base.model': { BaseModel } });
  try {
    for (const [id, column] of [[account.waba_id, 'waba_id'], [account.id, 'id']]) {
      await model.findOwnedForSync(id, 'owner', 'company');
      const q = statements.at(-1);
      assert.match(q.sql, new RegExp(`"${column}" = \\?`));
      assert.ok(q.bindings.includes('owner') && q.bindings.includes('company'));
      assert.match(q.sql, /"deleted_at" is null/);
    }
    await model.syncAccountAndPhones(account, { name: 'New WABA' }, [phone('1001')]);
    const upsert = statements.find(q => q.method === 'insert');
    assert.match(upsert.sql, /on conflict \("phone_number_id"\) do update/);
    assert.match(upsert.sql, /where "phone_numbers"\."user_id" = \? and "phone_numbers"\."company_id" = \? and "phone_numbers"\."waba_id" = \?/);
    assert.doesNotMatch(upsert.sql, /"id" = "excluded"/);
    assert.ok(statements.some(q => /for update/.test(q.sql)));
  } finally { await db.destroy(); }
});

test('controller uses the team owner and exposes the new sync route under account scope', async () => {
  const calls = [];
  const controller = load('src/app/http/controllers/waba.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
    '@surefy/console/services/waba.service': { syncWaba: async (...args) => { calls.push(args); return { created: 1 }; } },
  });
  assert.equal((await controller.syncWaba({ ownerId: 'owner', userId: 'member', companyId: 'company', params: { wabaId: '123456' } }, {})).created, 1);
  assert.deepEqual(calls[0], ['owner', 'company', '123456']);
  const routes = [], scope = () => {};
  const router = Object.fromEntries(['use', 'get', 'post', 'put', 'delete'].map(method => [method, (...args) => routes.push([method, ...args])]));
  load('src/routes/waba.route.ts', { express: { Router: () => router },
    '../app/http/middleware/accountScope': { accountScope: scope, ownedResource: () => () => {}, ownedPhone: () => {} },
    '@surefy/console/http/controllers/waba.controller': controller });
  assert.equal(routes[0][1], scope);
  assert.ok(routes.some(([method, path, handler]) => method === 'post' && path === '/:wabaId/sync' && handler === controller.syncWaba));
});
