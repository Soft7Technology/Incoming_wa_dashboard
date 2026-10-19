require('dotenv/config');
require('ts-node/register');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const knex = require('knex');
const { load } = require('../tests/shopify-helpers.cjs');
const { CustomError } = require('../library/surefy/src/exceptions/CustomError');

(async () => {
  if (process.env.NODE_ENV !== 'development') throw Error('Use the development database for this isolated fixture.');
  process.env.GOOGLE_PEOPLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString('base64');
  process.env.GOOGLE_PEOPLE_REDIRECT_URI = 'https://fixture.example.test/v1/integrations/google-people/callback';
  const utils = load('src/app/utils/googlePeople.ts', { '@surefy/exceptions/CustomError': { CustomError } });
  const { GooglePeopleService } = load('src/app/services/googlePeople.service.ts', {
    '@surefy/database': {}, './googlePeopleClient.service': { GooglePeopleClient: class {} }, '../utils/googlePeople': utils,
  });
  const database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 }, acquireConnectionTimeout: 10000 });
  const schema = 'google_people_check_' + crypto.randomBytes(8).toString('hex'), rollback = new Error('Fixture rollback');
  try {
    await database.transaction(async trx => {
      await trx.raw("set local statement_timeout = '20s'");
      await trx.raw('create schema ??', [schema]);
      await trx.raw("select set_config('search_path', ?, true)", [schema + ',public']);
      for (const table of ['companies', 'users']) await trx.schema.createTable(table, t => {
        t.uuid('id').primary(); if (table === 'users') t.uuid('company_id'); t.string('status'); t.timestamp('deleted_at');
      });
      await require('../src/database/migrations/20261017000004_google_people').up(trx);
      const scope = { companyId: crypto.randomUUID(), ownerId: crypto.randomUUID() }; scope.userId = scope.ownerId;
      await trx('companies').insert({ id: scope.companyId, status: 'active' });
      await trx('users').insert({ id: scope.ownerId, company_id: scope.companyId, status: 'active' });
      let etag = 'v1', refreshes = 0, writes = 0;
      const google = {
        exchange: async () => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, scope: utils.contactsScope }),
        refresh: async () => { refreshes++; return { access_token: 'fixture-renewed', expires_in: 3600 }; },
        create: async (_token, person) => { writes++; return { resourceName: 'people/c123', ...person }; },
        get: async () => ({ resourceName: 'people/c123', etag: 'root', metadata: { sources: [{ type: 'CONTACT', id: '123', etag }] } }),
        update: async (_token, _resource, person, fields) => { writes++; assert.equal(fields.join(','), 'phoneNumbers'); etag = 'v2'; return { ...person, metadata: { sources: [{ type: 'CONTACT', id: '123', etag }] } }; },
        list: async () => ({ connections: [] }),
      };
      const service = new GooglePeopleService(trx, google);
      await service.saveApp(scope, { client_id: 'fixture-client', client_secret: 'fixture-secret' });
      const start = await service.start(scope);
      await service.callback(new URL(start.authorization_url).searchParams.get('state'), start.browser, 'fixture-code', false);
      assert.equal((await service.connection(scope)).connected, true);
      const stored = await trx('google_people_connections').first();
      assert.equal(utils.decrypt(stored.access_token_ciphertext, scope), 'fixture-access');
      assert.equal(stored.scopes[0], utils.contactsScope);
      const created = await service.createContact(scope, { names: [{ givenName: 'Fixture' }] });
      assert.equal(created.resourceName, 'people/c123');
      await service.updateContact(scope, 'c123', { source_etag: 'v1', phoneNumbers: [{ value: '+14155552671' }] });
      await assert.rejects(service.updateContact(scope, 'c123', { source_etag: 'v1', phoneNumbers: [] }), e => e.statusCode === 409);
      assert.equal(writes, 2);
      await trx('google_people_connections').update({ token_expires_at: new Date(0) });
      await service.list(scope); await service.list(scope);
      assert.equal(refreshes, 1);
      await assert.rejects(trx.transaction(async savepoint => {
        await savepoint('google_people_connections').insert({ ...stored, id: crypto.randomUUID(), scopes: JSON.stringify(stored.scopes) });
      }), e => e.code === '23505');
      await trx('users').where({ id: scope.ownerId }).delete();
      for (const table of ['google_people_connections', 'google_people_oauth_sessions', 'google_people_oauth_apps'])
        assert.equal(Number((await trx(table).count('* as total').first()).total), 0);
      throw rollback;
    }).catch(error => { if (error !== rollback) throw error; });
    assert.equal((await database.raw('select schema_name from information_schema.schemata where schema_name = ?', [schema])).rows.length, 0);
    console.info('Google People PostgreSQL fixture passed: OAuth, custom credentials, create/update, stale edits, refresh, uniqueness, cascades and complete rollback. No Google contacts were changed.');
  } finally { await database.destroy(); }
})().catch(error => {
  console.error('Google People database fixture failed:', error?.code || error?.name || 'Unknown error');
  console.error(JSON.stringify({ location: error?.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 2) }));
  process.exitCode = 1;
});
