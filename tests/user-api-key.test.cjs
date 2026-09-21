const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const knex = require('knex');

function load(file, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, { exports, Buffer, process: { env: { USER_API_KEY_ENCRYPTION_KEY: 'ab'.repeat(32) } }, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return exports;
}

function loadService(model) {
  class HttpError extends Error { constructor(data) { super(data.message); } }
  return load('src/app/services/userApiKey.service.ts', {
    crypto, uuid: require('uuid'), '../models/userApiKey.model': model,
    '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP403Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError,
  }).default;
}

test('issued API keys have cryptographic entropy and their plaintext is not stored', async () => {
  let inserted;
  const service = loadService({
    findActiveUser: async () => ({}),
    createKey: async data => { inserted = data; return { id: 'key-id' }; },
  });
  const first = await service.createKey({ userId: 'owner', companyId: 'company' });
  assert.match(first.apiKey, /^s7_[a-f0-9]{64}$/);
  assert.equal(inserted.key_hash, crypto.createHash('sha256').update(first.apiKey).digest('hex'));
  assert.ok(!JSON.stringify(inserted).includes(first.apiKey));
  assert.equal(inserted.user_id, 'owner');
  assert.equal('name' in inserted, false);
  assert.equal(inserted.company_id, 'company');
  const second = await service.createKey({ userId: 'owner', companyId: 'company' });
  assert.notEqual(first.apiKey, second.apiKey);
});

test('lookup excludes revoked keys, inactive/deleted accounts, and changed company membership', async () => {
  const db = knex({ client: 'pg' });
  const queries = [];
  db.client.runner = b => ({ run: async () => { queries.push(b.toSQL()); return undefined; } });
  try {
    class BaseModel { constructor(table) { this.db = db; this.query = () => db(table); } }
    const model = load('src/app/models/userApiKey.model.ts', {
      '@surefy/models/base.model': { BaseModel },
    }).default;
    const service = loadService(model);
    assert.equal(await service.authenticate('invalid'), null);
    assert.equal(queries.length, 0);
    await service.authenticate('s7_' + 'a'.repeat(64));
    const q = queries[0];
    for (const fragment of ['"k"."revoked_at" is null', '"u"."deleted_at" is null',
      '"c"."deleted_at" is null', 'u.company_id = k.company_id']) assert.ok(q.sql.includes(fragment));
    assert.deepEqual(q.bindings.slice(1, 3), ['active', 'active']);
  } finally { await db.destroy(); }
});

test('single-key authentication supplies owner context and rejects revoked credentials', async () => {
  let account = { userId: 'owner', companyId: 'company', userRole: 'user' };
  class Unauthorized extends Error { constructor(data) { super(data.message); } }
  const middleware = load('library/surefy/src/middleware/auth.middleware.ts', {
    '../services/userApiKey.service': { authenticateUserApiKey: async () => account },
    '../exceptions/HTTP401Error': Unauthorized,
    '../services/auth.service': { generateCompanyKey() {} },
  });
  const req = { headers: { 'x-api-key': 's7_' + 'a'.repeat(64) } };
  let error;
  await middleware.authMiddleware(req, {}, e => { error = e; });
  assert.equal(error, undefined);
  assert.equal(req.userId, 'owner');
  assert.equal(req.ownerId, 'owner');
  assert.equal(req.companyId, 'company');
  account = null;
  await middleware.authMiddleware({ headers: req.headers }, {}, e => { error = e; });
  assert.match(error.message, /Invalid or revoked/);
  await middleware.authMiddleware({ headers: {} }, {}, e => { error = e; });
  assert.ok(error instanceof Unauthorized);
  const legacy = { headers: { 'x-api-key': 'legacy', 'x-company-key': 'company-key' } };
  await middleware.authMiddleware(legacy, {}, e => { error = e; });
  assert.ok(error instanceof Unauthorized);
  assert.equal(legacy.companyId, undefined);
  await middleware.optionalAuthMiddleware({ headers: {} }, {}, e => { error = e; });
  assert.equal(error, undefined);
  await middleware.optionalAuthMiddleware({ headers: { 'x-api-key': '' } }, {}, e => { error = e; });
  assert.ok(error instanceof Unauthorized);
  await middleware.optionalAuthMiddleware(legacy, {}, e => { error = e; });
  assert.ok(error instanceof Unauthorized);
  await middleware.authMiddleware({ headers: { 'x-api-key': ['one', 'two'] } }, {}, e => { error = e; });
  assert.ok(error instanceof Unauthorized);
});

test('management validates users and inputs and scopes revocation', async () => {
  const calls = [];
  const service = loadService({
    findActiveUser: async () => ({}),
    findByOwner: async (...args) => { calls.push(args); return []; },
    revokeByOwner: async (...args) => { calls.push(args); return 0; },
  });
  const owner = { userId: 'owner', companyId: 'company' };
  await service.getKeys({ ...owner, userRole: 'member', ownerId: 'other' });
  assert.deepEqual(calls.pop(), ['owner', 'company']);
  await assert.rejects(service.getKeys({ userId: 'owner' }), /User and company context/);
  await assert.rejects(service.revokeKey(owner, 'invalid'), /Invalid API key ID/);
  await service.getKeys(owner);
  assert.deepEqual(calls[0], ['owner', 'company']);
  const id = '8f751a82-1022-4e7d-828f-d67a94f2c448';
  await assert.rejects(service.revokeKey(owner, id), /API key not found/);
  assert.deepEqual(calls[1], [id, 'owner', 'company']);
});

test('different users in one company receive separate keys and user-scoped lists', async () => {
  const records = [];
  const service = loadService({
    findActiveUser: async () => ({}),
    createKey: async data => { records.push(data); return { id: String(records.length) }; },
    findByOwner: async (userId, companyId) => records.filter(r => r.user_id === userId && r.company_id === companyId),
  });
  const first = await service.createKey({ userId: 'user-a', companyId: 'company' });
  const second = await service.createKey({ userId: 'user-b', companyId: 'company', userRole: 'member', ownerId: 'user-a' });
  assert.notEqual(first.apiKey, second.apiKey);
  const keys = await service.getKeys({ userId: 'user-b', companyId: 'company' });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].user_id, 'user-b');
});

test('rotation locks the user and revokes previous keys before inserting in one transaction', async () => {
  const db = knex({ client: 'pg' });
  const queries = [];
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    queries.push(query);
    return query.method === 'insert' ? [{ id: 'new-key' }] : [];
  } });
  let transactions = 0;
  const database = { transaction: async fn => { transactions++; return fn(db); } };
  class BaseModel { constructor() { this.db = database; } }
  try {
    const model = load('src/app/models/userApiKey.model.ts', {
      '@surefy/models/base.model': { BaseModel },
    }).default;
    const result = await model.createKey({ user_id: 'user-a', company_id: 'company', key_hash: 'hash', key_prefix: 'prefix' });
    assert.equal(transactions, 1);
    assert.equal(result.id, 'new-key');
    assert.match(queries[0].sql, /for update/);
    assert.equal(queries[0].bindings[0], 'user-a');
    assert.match(queries[1].sql, /update "user_api_keys"/);
    assert.match(queries[1].sql, /"revoked_at" is null/);
    assert.deepEqual(queries[1].bindings, ['user-a']);
    assert.match(queries[2].sql, /insert into "user_api_keys"/);
  } finally { await db.destroy(); }
});

test('dashboard decrypts its user key and handles older hash-only records', async () => {
  let record;
  const service = loadService({
    findActiveUser: async () => ({}),
    createKey: async data => { record = data; return { id: 'key' }; },
    findByOwner: async () => [{ id: 'key', api_key_encrypted: record.api_key_encrypted }, { id: 'old' }],
  });
  const account = { userId: 'user-a', companyId: 'company' };
  const created = await service.createKey(account);
  assert.ok(record.api_key_encrypted);
  assert.ok(!record.api_key_encrypted.includes(created.apiKey));
  const keys = await service.getKeys(account);
  assert.equal(keys[0].apiKey, created.apiKey);
  assert.equal(keys[0].api_key_encrypted, undefined);
  assert.equal(keys[1].apiKey, null);
  await assert.rejects(service.getKeys({ userId: 'other', companyId: 'company' }));
});
