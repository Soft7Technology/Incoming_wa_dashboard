require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, memoryDatabase } = require('./shopify-helpers.cjs');
const { CustomError } = require('../library/surefy/src/exceptions/CustomError');
Object.assign(process.env, {
  GOOGLE_PEOPLE_REDIRECT_URI: 'https://api.example.test/v1/integrations/google-people/callback',
  GOOGLE_PEOPLE_CLIENT_ID: 'shared-client',
  GOOGLE_PEOPLE_CLIENT_SECRET: 'shared-secret',
  GOOGLE_PEOPLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 37).toString('base64'),
  GOOGLE_PEOPLE_REQUIRE_CUSTOM_CLIENT: 'false',
});
const utils = load('src/app/utils/googlePeople.ts', { '@surefy/exceptions/CustomError': { CustomError } });
const { GooglePeopleService } = load('src/app/services/googlePeople.service.ts', {
  '@surefy/database': {},
  './googlePeopleClient.service': { GooglePeopleClient: class {} },
  '../utils/googlePeople': utils,
});
const scope = { companyId: crypto.randomUUID(), ownerId: crypto.randomUUID() };
scope.userId = scope.ownerId;
const other = { ...scope, companyId: crypto.randomUUID() };
const tokens = () => ({
  access_token: 'people-access',
  refresh_token: 'people-refresh',
  expires_in: 3600,
  scope: utils.contactsScope,
});
function fixture() {
  const database = memoryDatabase({
    users: [{ id: scope.ownerId, company_id: scope.companyId, status: 'active' }],
    companies: [{ id: scope.companyId, status: 'active' }],
  });
  const calls = { exchange: [], refresh: [], create: [], update: [], list: [], get: [] };
  let person = {
    resourceName: 'people/c123',
    etag: 'person-v1',
    metadata: { sources: [{ type: 'CONTACT', id: '123', etag: 'contact-v1' }] },
    names: [{ givenName: 'Original' }],
    emailAddresses: [{ value: 'original@example.test' }],
    phoneNumbers: [{ value: '+14155552671' }],
  };
  const google = {
    async exchange(...args) {
      calls.exchange.push(args);
      return tokens();
    },
    async refresh(...args) {
      calls.refresh.push(args);
      return { access_token: 'renewed-access', expires_in: 3600 };
    },
    async list(...args) {
      calls.list.push(args);
      return { connections: [structuredClone(person)], nextPageToken: 'next-page' };
    },
    async get(...args) {
      calls.get.push(args);
      return structuredClone(person);
    },
    async create(...args) {
      calls.create.push(args);
      person = { ...person, ...args[1] };
      return structuredClone(person);
    },
    async update(...args) {
      calls.update.push(args);
      person = {
        ...person,
        ...args[2],
        etag: 'person-v2',
        metadata: { sources: [{ type: 'CONTACT', id: '123', etag: 'contact-v2' }] },
      };
      return structuredClone(person);
    },
  };
  return {
    database,
    google,
    calls,
    service: new GooglePeopleService(database, google),
    setPerson: (value) => {
      person = value;
    },
  };
}
async function connect(f) {
  const start = await f.service.start(scope),
    url = new URL(start.authorization_url);
  await f.service.callback(url.searchParams.get('state'), start.browser, 'test-code', false);
  return start;
}

test('People OAuth uses only contacts scope, PKCE, encrypted account-bound credentials and single-use browser state', async () => {
  const f = fixture(),
    start = await f.service.start(scope),
    url = new URL(start.authorization_url);
  assert.equal(url.searchParams.get('scope'), utils.contactsScope);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('client_id'), 'shared-client');
  assert.ok(!JSON.stringify(start).includes('shared-secret'));
  const pending = f.database.tables().google_people_oauth_sessions[0];
  assert.ok(!JSON.stringify(pending).includes('shared-secret'));
  await assert.rejects(
    f.service.callback(url.searchParams.get('state'), utils.random(), 'code', false),
    /expired|cancelled/,
  );
  await f.service.callback(url.searchParams.get('state'), start.browser, 'code', false);
  const row = f.database.tables().google_people_connections[0];
  assert.equal(utils.decrypt(row.access_token_ciphertext, scope), 'people-access');
  assert.throws(() => utils.decrypt(row.access_token_ciphertext, other), /decrypt/);
  assert.equal(
    crypto.createHash('sha256').update(f.calls.exchange[0][1]).digest('base64url'),
    url.searchParams.get('code_challenge'),
  );
  assert.ok(!JSON.stringify(await f.service.connection(scope)).includes('people-access'));
  await assert.rejects(f.service.callback(url.searchParams.get('state'), start.browser, 'code', false), /expired|used/);
  assert.equal(f.calls.exchange.length, 1);
});

test('white-label credentials are account scoped, encrypted and pinned through refresh; changing them cancels old authorization', async () => {
  const f = fixture();
  await f.service.saveApp(scope, { client_id: 'brand-client', client_secret: 'brand-secret' });
  assert.ok(!JSON.stringify(f.database.tables().google_people_oauth_apps).includes('brand-secret'));
  assert.equal((await f.service.setup(scope)).client_id, 'brand-client');
  assert.ok(!JSON.stringify(await f.service.setup(scope)).includes('brand-secret'));
  await assert.rejects(f.service.saveApp(other, { client_id: 'other', client_secret: 'secret' }), /inactive/);
  await connect(f);
  assert.equal(f.calls.exchange[0][2].clientId, 'brand-client');
  await f.database('google_people_connections').update({ token_expires_at: new Date(0) });
  await f.service.list(scope);
  assert.equal(f.calls.refresh[0][1].clientSecret, 'brand-secret');
  const start = await f.service.start(scope);
  await f.service.saveApp(scope, { client_id: 'new-brand-client', client_secret: 'new-brand-secret' });
  assert.equal((await f.service.connection(scope)).connected, false);
  await assert.rejects(
    f.service.callback(new URL(start.authorization_url).searchParams.get('state'), start.browser, 'code', false),
    /expired|cancelled/,
  );
});

test('create/read/update support field replacement, preserve omitted fields and reject stale or profile-only edits', async () => {
  const f = fixture();
  await connect(f);
  const created = await f.service.createContact(scope, {
    names: [{ givenName: 'Test' }],
    emailAddresses: [{ value: 'test@example.test' }],
  });
  assert.equal(created.resourceName, 'people/c123');
  const read = await f.service.get(scope, 'c123');
  assert.equal(read.metadata.sources[0].etag, 'contact-v1');
  const updated = await f.service.updateContact(scope, 'people/c123', {
    source_etag: 'contact-v1',
    emailAddresses: [],
  });
  assert.equal(f.calls.update[0][3].join(','), 'emailAddresses');
  assert.equal(f.calls.update[0][2].metadata.sources[0].etag, 'contact-v1');
  assert.equal(f.calls.update[0][2].names, undefined);
  assert.equal(updated.names[0].givenName, 'Test');
  assert.equal(updated.emailAddresses.length, 0);
  await assert.rejects(
    f.service.updateContact(scope, 'c123', { source_etag: 'contact-v1', names: [{ givenName: 'Stale' }] }),
    /changed/,
  );
  assert.equal(f.calls.update.length, 1);
  await f.service.updateContact(scope, 'c123', { source_etag: 'contact-v2', phoneNumbers: [] });
  assert.equal(f.calls.update.length, 2);
  f.setPerson({ resourceName: 'people/123', metadata: { sources: [{ type: 'PROFILE', id: '123', etag: 'v1' }] } });
  await assert.rejects(
    f.service.updateContact(scope, '123', { source_etag: 'v1', names: [{ givenName: 'No' }] }),
    /contact-based/,
  );
  assert.ok(!JSON.stringify(f.database.tables()).includes('test@example.test'));
});

test('invalid fields/identifiers/page tokens never reach Google, and owner/company isolation blocks data access', async () => {
  const f = fixture();
  await connect(f);
  for (const body of [
    { names: [{ givenName: 'a' }, { givenName: 'b' }] },
    { emailAddresses: [{ value: 'bad' }] },
    { phoneNumbers: [{ value: '' }] },
    { names: [{ displayName: 'output-only' }] },
    { addresses: [] },
    {},
  ])
    await assert.rejects(f.service.createContact(scope, body));
  for (const id of ['people/me', 'https://example.com/a', '../c123', 'c123?x=y', 'people/c123/else'])
    await assert.rejects(f.service.get(scope, id));
  await assert.rejects(f.service.updateContact(scope, 'c123', { names: [] }), /source_etag/);
  await assert.rejects(f.service.list(scope, { page_size: 1001 }));
  await assert.rejects(f.service.list(scope, { page_token: ['injected'] }));
  await assert.rejects(f.service.get({ ...scope, userId: crypto.randomUUID() }, 'c123'), /owner/);
  await assert.rejects(f.service.get(other, 'c123'), /inactive/);
  assert.equal(f.calls.create.length + f.calls.get.length + f.calls.update.length + f.calls.list.length, 0);
});

test('mutations serialize, refresh once and preserve renewed credentials after a failed write without retrying it', async () => {
  const f = fixture();
  await connect(f);
  await f.database('google_people_connections').update({ token_expires_at: new Date(0) });
  let active = 0,
    peak = 0,
    writes = 0;
  f.google.create = async () => {
    writes++;
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { resourceName: 'people/c123' };
  };
  await Promise.all([1, 2, 3].map((n) => f.service.createContact(scope, { names: [{ givenName: String(n) }] })));
  assert.equal(peak, 1);
  assert.equal(writes, 3);
  assert.equal(f.calls.refresh.length, 1);
  await f.database('google_people_connections').update({ token_expires_at: new Date(0) });
  f.google.create = async () => {
    writes++;
    throw Error('Unconfirmed write');
  };
  await assert.rejects(f.service.createContact(scope, { names: [{ givenName: 'Maybe' }] }), /Unconfirmed/);
  await f.service.get(scope, 'c123');
  assert.equal(writes, 4);
  assert.equal(f.calls.refresh.length, 2);
});

test('disconnect cancels pending OAuth and removes only People credentials, preserving Sheets connections', async () => {
  const f = fixture();
  await f.database('google_sheet_connections').insert({ id: 'sheet-fixture', owner_id: scope.ownerId });
  await connect(f);
  const pending = await f.service.start(scope);
  await f.service.disconnect(scope);
  assert.equal((await f.service.connection(scope)).connected, false);
  assert.equal(f.database.tables().google_sheet_connections.length, 1);
  await assert.rejects(
    f.service.callback(new URL(pending.authorization_url).searchParams.get('state'), pending.browser, 'code', false),
    /expired|cancelled/,
  );
});

test('Google client sends contact-only reads, exact update masks and custom OAuth credentials; provider failures reveal no secrets', async () => {
  const requests = [];
  const { GooglePeopleClient } = load('src/app/services/googlePeopleClient.service.ts', {
    '../utils/googlePeople': utils,
    axios: {
      request: async (config) => {
        requests.push(config);
        return { data: tokens() };
      },
    },
  });
  const client = new GooglePeopleClient(),
    app = {
      clientId: 'custom-id',
      clientSecret: 'custom-secret',
      redirectUri: 'https://api.example.test/v1/integrations/google-people/callback',
    };
  await client.exchange('code', 'verifier', app);
  assert.equal(new URLSearchParams(requests[0].data).get('client_secret'), 'custom-secret');
  await client.get('private-token', 'c123');
  assert.equal(requests[1].params.sources, 'READ_SOURCE_TYPE_CONTACT');
  await client.update('private-token', 'c123', { names: [] }, ['names']);
  assert.equal(requests[2].method, 'patch');
  assert.equal(requests[2].params.updatePersonFields, 'names');
  assert.equal(requests[2].maxRedirects, 0);
  for (const [status, data, expected] of [
    [403, {}, 403],
    [404, {}, 404],
    [429, {}, 429],
    [400, { error: { errors: [{ reason: 'failedPrecondition' }] } }, 409],
    [0, {}, 502],
  ]) {
    let calls = 0;
    const module = load('src/app/services/googlePeopleClient.service.ts', {
      '../utils/googlePeople': utils,
      axios: {
        request: async () => {
          calls++;
          throw { config: { secret: 'private-token', data: 'customer-private' }, response: { status, data } };
        },
      },
    });
    await assert.rejects(
      new module.GooglePeopleClient().create('private-token', {}),
      (e) => e.statusCode === expected && !/private-token|customer-private/.test(e.message),
    );
    assert.equal(calls, 1);
  }
});

test('HTTP endpoints require owner auth, protect OAuth cookies, create/edit contacts and serve the browser app', async () => {
  const express = require('express'),
    f = fixture();
  const controller = load('src/app/http/controllers/googlePeople.controller.ts', {
    '@surefy/utils/Controller': require('../library/surefy/src/utils/Controller'),
    '../../services/googlePeople.service': f.service,
    '../../utils/googlePeople': utils,
  });
  const route = load('src/routes/googlePeople.route.ts', {
    express,
    '../app/http/controllers/googlePeople.controller': controller,
    '../app/http/middleware/accountScope': { accountScope: (_req, _res, next) => next() },
    '@surefy/middleware/jwtAuth.middleware': {
      requireRole: () => (req, res, next) => (req.userRole === 'user' ? next() : res.sendStatus(403)),
    },
  }).default;
  const publicRoute = load('src/routes/googlePeoplePublic.route.ts', {
    express,
    '../app/http/controllers/googlePeople.controller': controller,
  }).default;
  const app = express();
  app.use(express.json());
  app.use(
    '/v1/admin/google-people',
    (req, res, next) => {
      if (!req.headers.authorization) return res.sendStatus(401);
      Object.assign(req, scope, { userRole: req.headers.authorization === 'Bearer member' ? 'member' : 'user' });
      next();
    },
    route,
  );
  app.use('/v1/integrations/google-people', publicRoute);
  app.use((error, _req, res, _next) =>
    res.status(error.statusCode || 500).json({ success: false, message: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`,
    auth = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(origin + '/v1/admin/google-people/contacts')).status, 401);
    assert.equal(
      (await fetch(origin + '/v1/admin/google-people/contacts', { headers: { Authorization: 'Bearer member' } }))
        .status,
      403,
    );
    const page = await fetch(origin + '/v1/integrations/google-people/app');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Google Contacts/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const start = await fetch(origin + '/v1/admin/google-people/oauth/start', {
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    assert.match(start.headers.get('set-cookie'), /HttpOnly/);
    assert.match(start.headers.get('set-cookie'), /Path=\/v1\/integrations\/google-people/);
    const url = new URL((await start.json()).data.authorization_url);
    const callback = await fetch(
      origin +
        '/v1/integrations/google-people/callback?' +
        new URLSearchParams({ state: url.searchParams.get('state'), code: 'test-code' }),
      { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } },
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/v1/integrations/google-people/app?connected=1');
    const created = await fetch(origin + '/v1/admin/google-people/contacts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ names: [{ givenName: 'HTTP contact' }] }),
    });
    assert.equal(created.status, 201);
    const updated = await fetch(origin + '/v1/admin/google-people/contacts/c123', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ source_etag: 'contact-v1', phoneNumbers: [{ value: '+14155552671' }] }),
    });
    assert.equal(updated.status, 200);
    assert.equal(
      (
        await fetch(origin + '/v1/admin/google-people/contacts/c123', {
          method: 'PATCH',
          headers: auth,
          body: JSON.stringify({ source_etag: 'contact-v1', names: [] }),
        })
      ).status,
      409,
    );
    const connection = await fetch(origin + '/v1/admin/google-people/connection', { headers: auth });
    assert.ok(!/people-access|shared-secret|people-refresh/.test(await connection.text()));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
