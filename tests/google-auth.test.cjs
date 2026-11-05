require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { load, memoryDatabase } = require('./shopify-helpers.cjs');
const { CustomError } = require('../library/surefy/src/exceptions/CustomError');
const origin = 'https://app.example.test';
const otherOrigin = 'https://other.example.test';
process.env.GOOGLE_AUTH_CLIENT_ID = 'test.apps.googleusercontent.com';
process.env.GOOGLE_AUTH_ALLOWED_ORIGINS = `${origin},${otherOrigin}`;
const { GoogleAuthService, GoogleTokenVerifier, googleAuthConfig } = load('src/app/services/googleAuth.service.ts', {
  '@surefy/database': {}, '@surefy/exceptions/CustomError': { CustomError },
});
const password = 'local-password-123';
const passwordHash = bcrypt.hashSync(password, 4);
const code = expected => error => error.details?.code === expected;

function fixture(overrides = {}) {
  const database = memoryDatabase({
    companies: [{ id: 'company-a', status: 'active' }, { id: 'company-b', status: 'active' }],
    company_domains: [
      { domain_name: 'app.example.test', company_id: 'company-a', status: 'active' },
      { domain_name: 'other.example.test', company_id: 'company-b', status: 'active' },
    ],
    users: [], google_auth_identities: [], google_auth_sessions: [], ...overrides,
  });
  let payload = { sub: 'google-123', email: 'customer@gmail.com', email_verified: true, name: 'Customer' };
  const verifier = { async verify(credential, audience, nonce) {
    assert.equal(audience, process.env.GOOGLE_AUTH_CLIENT_ID);
    assert.equal(typeof nonce, 'string');
    if (credential === 'invalid') throw new CustomError('Invalid', 401, true, { code: 'GOOGLE_TOKEN_INVALID' });
    return payload;
  } };
  const service = new GoogleAuthService(database, verifier);
  const start = (o = origin, user) => service.start(o, '192.0.2.1', user);
  const finish = (flow, extra = {}, o = origin, user) => service.complete(o, { credential: 'valid', flow_token: flow.flow_token, ...extra }, user);
  return { database, service, start, finish, setIdentity: value => { payload = { ...payload, ...value }; } };
}

test('signup derives tenant and role, stores no password, and replay cannot create another account', async () => {
  const f = fixture();
  const flow = await f.start();
  const result = await f.finish(flow, { role: 'superadmin', company_id: 'company-b', password: 'attacker', email: 'fake@gmail.com' });
  assert.equal(result.created, true);
  assert.equal(result.user.role, 'user');
  assert.equal(result.user.company_id, 'company-a');
  assert.equal(result.user.password, null);
  assert.equal(result.user.email, 'customer@gmail.com');
  assert.equal(f.database.tables().google_auth_identities[0].user_id, result.user.id);
  assert.ok(!JSON.stringify(f.database.tables()).includes(flow.flow_token));
  await assert.rejects(f.finish(flow), code('GOOGLE_FLOW_EXPIRED'));
  assert.equal(f.database.tables().users.length, 1);
});

test('returning Google users resolve by sub even if their Google email changes; tenant isolation holds', async () => {
  const f = fixture();
  const first = await f.finish(await f.start());
  f.setIdentity({ email: 'changed@gmail.com' });
  const second = await f.finish(await f.start());
  assert.equal(second.user.id, first.user.id);
  assert.equal(second.created, false);
  const otherFlow = await f.start(otherOrigin);
  await assert.rejects(f.finish(otherFlow, {}, otherOrigin), code('GOOGLE_ACCOUNT_UNAVAILABLE'));
  assert.equal(f.database.tables().users.length, 1);
});

test('existing Gmail and Workspace users sign in directly and retain their password and account', async () => {
  for (const identity of [{ email: 'customer@gmail.com' }, { email: 'customer@business.test', hd: 'business.test' }]) {
    const existing = { id: 'existing', email: identity.email.toUpperCase(), password: passwordHash,
      company_id: 'company-a', status: 'active', role: 'user', credit_balance: '200' };
    const f = fixture({ users: [existing] });
    f.setIdentity(identity);
    const result = await f.finish(await f.start());
    assert.equal(result.created, false);
    assert.equal(result.user.id, existing.id);
    assert.equal(result.user.password, passwordHash);
    assert.equal(await bcrypt.compare(password, result.user.password), true);
    assert.equal(result.user.credit_balance, '200');
    assert.deepEqual(f.database.tables().users, [existing]);
    assert.equal(f.database.tables().google_auth_identities[0].user_id, existing.id);
    assert.equal((await f.finish(await f.start())).user.id, existing.id);
  }
});

test('automatic linking rejects deleted, suspended, inactive and other-company accounts', async () => {
  for (const override of [{ deleted_at: new Date() }, { status: 'suspended' }, { status: 'inactive' }, { company_id: 'company-b' }]) {
    const f = fixture({ users: [{ id: 'existing', email: 'customer@gmail.com', password: passwordHash,
      company_id: 'company-a', status: 'active', ...override }] });
    await assert.rejects(f.finish(await f.start()), code('GOOGLE_ACCOUNT_UNAVAILABLE'));
    assert.equal(f.database.tables().google_auth_identities.length, 0);
  }
});

test('third-party or unverified email cannot automatically link an existing account', async () => {
  for (const identity of [{ email: 'customer@example.org' }, { email: 'customer@gmail.com', email_verified: false }]) {
    const f = fixture({ users: [{ id: 'existing', email: identity.email, password: passwordHash, company_id: 'company-a', status: 'active' }] });
    f.setIdentity(identity);
    await assert.rejects(f.finish(await f.start()), code('GOOGLE_ACCOUNT_LINK_REQUIRED'));
    assert.equal(f.database.tables().google_auth_identities.length, 0);
  }
});

test('automatic linking never replaces another Google identity or chooses between duplicate emails', async () => {
  const user = { id: 'existing', email: 'customer@gmail.com', password: passwordHash, company_id: 'company-a', status: 'active' };
  const linked = fixture({ users: [user], google_auth_identities: [{ google_sub: 'original-google', user_id: user.id }] });
  await assert.rejects(linked.finish(await linked.start()), code('GOOGLE_ALREADY_LINKED'));
  assert.equal(linked.database.tables().google_auth_identities[0].google_sub, 'original-google');
  const duplicate = fixture({ users: [user, { ...user, id: 'another', email: 'CUSTOMER@gmail.com' }] });
  await assert.rejects(duplicate.finish(await duplicate.start()), code('GOOGLE_ACCOUNT_CONFLICT'));
  assert.equal(duplicate.database.tables().google_auth_identities.length, 0);
});

test('simultaneous first Google logins link one existing account without changing its password', async () => {
  const user = { id: 'existing', email: 'customer@gmail.com', password: passwordHash, company_id: 'company-a', status: 'active' };
  const f = fixture({ users: [user] });
  const flows = await Promise.all([f.start(), f.start()]);
  const results = await Promise.all(flows.map(flow => f.finish(flow)));
  assert.ok(results.every(result => result.user.id === user.id && result.created === false));
  assert.equal(f.database.tables().google_auth_identities.length, 1);
  assert.deepEqual(f.database.tables().users, [user]);
});

test('link requires matching email, password, user-bound flow and correct purpose', async () => {
  const existing = { id: 'existing', email: 'customer@gmail.com', password: passwordHash, status: 'active', company_id: 'company-a' };
  const f = fixture({ users: [existing, { ...existing, id: 'other' }] });
  const flow = await f.start(origin, 'existing');
  await assert.rejects(f.finish(flow), code('GOOGLE_FLOW_EXPIRED'));
  await assert.rejects(f.finish(flow, { current_password: password }, origin, 'other'), code('GOOGLE_FLOW_EXPIRED'));
  await assert.rejects(f.finish(flow, { current_password: 'wrong' }, origin, 'existing'), code('GOOGLE_PASSWORD_REQUIRED'));
  f.setIdentity({ email: 'wrong@gmail.com' });
  await assert.rejects(f.finish(flow, { current_password: password }, origin, 'existing'), code('GOOGLE_EMAIL_MISMATCH'));
  f.setIdentity({ email: 'customer@gmail.com' });
  const result = await f.finish(flow, { current_password: password }, origin, 'existing');
  assert.equal(result.user.id, 'existing');
  assert.equal(f.database.tables().users[0].password, passwordHash);
  assert.equal(f.database.tables().google_auth_identities.length, 1);
});

test('one account cannot overwrite another Google identity', async () => {
  const f = fixture({
    users: [{ id: 'existing', email: 'customer@gmail.com', password: passwordHash, status: 'active', company_id: 'company-a' }],
    google_auth_identities: [{ google_sub: 'a-different-google', user_id: 'existing' }],
  });
  await assert.rejects(f.finish(await f.start(origin, 'existing'), { current_password: password }, origin, 'existing'), code('GOOGLE_ALREADY_LINKED'));
  assert.equal(f.database.tables().google_auth_identities[0].google_sub, 'a-different-google');
});

test('suspended/deleted users and inactive companies cannot use Google to bypass restrictions', async () => {
  const f = fixture();
  await f.finish(await f.start());
  for (const status of ['inactive', 'suspended']) {
    f.database.tables().users[0].status = status;
    await assert.rejects(f.finish(await f.start()), code('GOOGLE_ACCOUNT_UNAVAILABLE'));
    // The fixture replaces tables on transaction rollback; mutate the current row next time.
    f.database.tables().users[0].status = 'active';
  }
  f.database.tables().users[0].deleted_at = new Date();
  await assert.rejects(f.finish(await f.start()), code('GOOGLE_ACCOUNT_UNAVAILABLE'));
  f.database.tables().companies[0].status = 'suspended';
  await assert.rejects(f.start(), code('GOOGLE_DOMAIN_UNAVAILABLE'));
});

test('third-party email signup needs an existing local account; Workspace signup is supported', async () => {
  const f = fixture();
  f.setIdentity({ email: 'customer@example.org' });
  await assert.rejects(f.finish(await f.start()), code('GOOGLE_EMAIL_VERIFICATION_REQUIRED'));
  assert.equal(f.database.tables().users.length, 0);
  f.setIdentity({ hd: 'example.org' });
  assert.equal((await f.finish(await f.start())).created, true);
});

test('origin, expiration, bounded attempts and start throttling are enforced', async () => {
  for (const bad of [undefined, 'null', 'https://app.example.test.attacker.tld', origin + '/', origin + '/path']) {
    assert.throws(() => googleAuthConfig(bad), code('GOOGLE_ORIGIN_NOT_ALLOWED'));
  }
  const f = fixture();
  const flow = await f.start();
  await assert.rejects(f.finish(flow, {}, otherOrigin), code('GOOGLE_FLOW_EXPIRED'));
  for (let i = 0; i < 5; i++) await assert.rejects(f.finish(flow, { credential: 'invalid' }), code('GOOGLE_TOKEN_INVALID'));
  await assert.rejects(f.finish(flow), code('GOOGLE_FLOW_EXPIRED'));
  const expired = await f.start();
  f.database.tables().google_auth_sessions[1].expires_at = new Date(Date.now() - 1000);
  await assert.rejects(f.finish(expired), code('GOOGLE_FLOW_EXPIRED'));
  for (let i = 2; i < 30; i++) await f.start();
  await assert.rejects(f.start(), code('GOOGLE_AUTH_RATE_LIMITED'));
});

test('concurrent completions of a flow produce only one successful login and identity', async () => {
  const f = fixture();
  const flow = await f.start();
  const results = await Promise.allSettled([f.finish(flow), f.finish(flow)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.database.tables().users.length, 1);
  assert.equal(f.database.tables().google_auth_identities.length, 1);
});

test('real Google verifier validates signature, audience, issuer, expiry, nonce and verified email', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verifier = new GoogleTokenVerifier();
  verifier.client.getFederatedSignonCertsAsync = async () => ({ certs: { test: publicKey.export({ type: 'spki', format: 'pem' }) } });
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: 'google-123', email: 'customer@gmail.com', email_verified: true, nonce: 'nonce',
    aud: process.env.GOOGLE_AUTH_CLIENT_ID, iss: 'https://accounts.google.com', iat: now, exp: now + 3600 };
  const sign = data => jwt.sign(data, privateKey, { algorithm: 'RS256', keyid: 'test' });
  assert.equal((await verifier.verify(sign(payload), payload.aud, 'nonce')).sub, payload.sub);
  for (const changes of [{ aud: 'attacker' }, { iss: 'attacker' }, { exp: now - 600 }, { nonce: 'wrong' }, { email_verified: false }, { sub: '' }]) {
    await assert.rejects(verifier.verify(sign({ ...payload, ...changes }), payload.aud, 'nonce'), code('GOOGLE_TOKEN_INVALID'));
  }
  const token = sign(payload).split('.');
  token[1] = Buffer.from(JSON.stringify({ ...payload, sub: 'attacker' })).toString('base64url');
  await assert.rejects(verifier.verify(token.join('.'), payload.aud, 'nonce'), code('GOOGLE_TOKEN_INVALID'));
});

test('Google-only accounts cannot crash or authenticate through password login', async () => {
  class Unauthorized extends Error { constructor({ message }) { super(message); } }
  const auth = load('src/app/services/auth.service.ts', {
    '../models/user.model': { findByEmailOrPhone: async () => ({ id: 'user', password: null, status: 'active' }) },
    '../models/company.model': {}, '@surefy/exceptions/HTTP400Error': Unauthorized, '@surefy/exceptions/HTTP401Error': Unauthorized,
    '../utils': {}, '../models/passwordReset.model': {}, '../models/userPlans.model': {}, '../models/team.model': {},
    '@surefy/database': {}, '../models/companyDomain.model': {}, '../utils/passwordPolicy': {}, '../models/subscription.model': {}, '../utils/freeTrialPolicy': {},
  }).default;
  await assert.rejects(auth.login({ identifier: 'customer@gmail.com', password: 'anything' }, '192.0.2.1'), /Invalid credentials/);
});

test('browser request guard rejects form posts and missing origins; proxy trust is explicit', () => {
  const controller = load('src/app/http/controllers/googleAuth.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: f => f }, '@surefy/exceptions/CustomError': { CustomError },
    '../../services/googleAuth.service': { googleAuthConfig }, '../../services/auth.service': {}, '@surefy/database': {},
  });
  const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; } };
  let error;
  controller.googleAuthRequest({ method: 'POST', get: () => origin, is: () => false }, res, e => { error = e; });
  assert.equal(error.statusCode, 400);
  assert.equal(headers['Cache-Control'], 'no-store');
  controller.googleAuthRequest({ method: 'POST', get: () => undefined, is: () => true }, res, e => { error = e; });
  assert.equal(error.statusCode, 403);
  const request = { socket: { remoteAddress: '10.1.2.3' }, headers: { 'x-forwarded-for': '192.0.2.7' } };
  delete process.env.GOOGLE_AUTH_TRUSTED_PROXIES;
  assert.equal(controller.googleAuthClientIp(request), '10.1.2.3');
  process.env.GOOGLE_AUTH_TRUSTED_PROXIES = '10.1.2.3';
  assert.equal(controller.googleAuthClientIp(request), '192.0.2.7');
  assert.equal(controller.googleAuthClientIp({ ...request, socket: { remoteAddress: '198.51.100.1' } }), '198.51.100.1');
  delete process.env.GOOGLE_AUTH_TRUSTED_PROXIES;
});

test('migration produces PostgreSQL identity uniqueness and nullable passwords, and blocks destructive rollback', async () => {
  const knex = require('knex')({ client: 'pg' });
  const statements = [];
  const migration = load('src/database/migrations/20261105000002_google_signin.ts');
  const database = Object.assign(table => ({ first: async () => ({ user_id: 'google-user' }) }), {
    raw: knex.raw.bind(knex), fn: knex.fn,
    schema: Object.fromEntries(['alterTable', 'createTable'].map(method => [method, async (table, callback) => {
      statements.push(...knex.schema[method](table, callback).toSQL().map(query => query.sql));
    }])),
  });
  try {
    await migration.up(database);
    const sql = statements.join('\n');
    assert.match(sql, /alter column "password" drop not null/);
    assert.match(sql, /primary key \("google_sub"\)/);
    assert.match(sql, /unique \("user_id"\)/);
    assert.match(sql, /references "users"/);
    assert.match(sql, /create table "google_auth_sessions"/);
    await assert.rejects(migration.down(database), /Migrate their login methods/);
  } finally { await knex.destroy(); }
});

test('password login and Google session issuance retain plan, owner, permissions and JWT shape', async () => {
  class Unauthorized extends Error { constructor({ message }) { super(message); } }
  process.env.JWT_SECRET = 'test-google-login-compatibility-secret';
  const user = { id: 'user-123', email: 'customer@gmail.com', password: passwordHash, status: 'active', company_id: 'company-a', role: 'user' };
  const plan = { active: true, plan_name: 'Pro', start_date: '2026-11-01', end_date: '2026-12-01' };
  let company = { id: 'company-a', status: 'active' };
  const updates = [];
  const auth = load('src/app/services/auth.service.ts', {
    '../models/user.model': { findByEmailOrPhone: async () => user, updateLastLogin: async (...args) => updates.push(args) },
    '../models/company.model': { findById: async () => company },
    '@surefy/exceptions/HTTP400Error': Unauthorized, '@surefy/exceptions/HTTP401Error': Unauthorized,
    '../utils': {}, '../models/passwordReset.model': {}, '../models/userPlans.model': { getUserPlan: async () => plan },
    '../models/team.model': { findOne: async () => ({ permission: ['INBOX'], invite_sent_by: 'team-owner' }) },
    '@surefy/database': () => ({ whereRaw() { return this; }, whereNull() { return this; }, count() { return this; }, first: async () => ({ count: '0' }) }),
    '../models/companyDomain.model': {}, '../utils/passwordPolicy': {}, '../models/subscription.model': {}, '../utils/freeTrialPolicy': {},
  }).default;
  const normal = await auth.login({ identifier: user.email, password, domain_name: 'app.example.test' }, '192.0.2.1');
  const google = await auth.createSession({ ...user, password: null }, '192.0.2.1', 'app.example.test');
  for (const result of [normal, google]) {
    assert.equal(result.data.plan_active, true);
    assert.equal(result.data.plan_name, 'Pro');
    assert.equal(result.data.owner_id, 'team-owner');
    assert.equal(result.data.permissions[0], 'inbox');
    assert.equal(result.data.password, undefined);
    const claims = jwt.verify(result.token, process.env.JWT_SECRET);
    assert.equal(claims.ownerId, 'team-owner');
    assert.equal(claims.companyId, 'company-a');
    assert.equal(claims.userId, user.id);
    assert.equal(claims.role, 'user');
  }
  assert.equal(normal.data.has_password, true);
  assert.equal(google.data.has_password, false);
  assert.equal(updates.length, 2);
  company = { ...company, status: 'suspended' };
  await assert.rejects(auth.createSession(user, '192.0.2.1'), /company is not active/);
});
