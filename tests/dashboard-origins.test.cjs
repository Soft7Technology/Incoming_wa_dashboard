const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { loadSource } = require('./helpers/background-database.cjs');
class AppError extends Error { constructor(message, status) { super(message); this.statusCode = status; } }
const domains = [
  { id: '1', company_id: 'a', domain_name: 'dashboard.alpha.test', status: 'active', ssl_status: 'active' },
  { id: '2', company_id: 'b', domain_name: 'https://dashboard.beta.test/', status: 'active', ssl_status: 'active' },
  { id: '3', company_id: 'a', domain_name: 'pending.test', status: 'pending', ssl_status: 'active' },
  { id: '4', company_id: 'a', domain_name: 'ssl-pending.test', status: 'active', ssl_status: 'pending' },
];
function memoryDb() {
  const tables = { company_domains: domains.map(row => ({ ...row })) };
  function db(name) {
    const rows = tables[name] ||= [];
    let predicate = () => true, operation = () => rows.filter(predicate);
    const query = {
      where(key, op, value) {
        const previous = predicate;
        predicate = row => previous(row) && (typeof key === 'object'
          ? Object.entries(key).every(([k,v]) => row[k] === v)
          : op === '>' ? row[key] > value : op === '<' ? row[key] < value : row[key] === op);
        return query;
      },
      whereIn(key, values) { const previous = predicate; predicate = row => previous(row) && values.includes(row[key]); return query; },
      first() { return Promise.resolve(rows.find(predicate)); },
      insert(row) { rows.push({ status: 'started', ...row }); return Promise.resolve(); },
      update(patch) { operation = () => rows.filter(predicate).map(row => Object.assign(row, patch)); return query; },
      returning() { return Promise.resolve(operation()); },
      delete() { operation = () => { tables[name] = rows.filter(row => !predicate(row)); }; return query; },
      then(resolve, reject) { return Promise.resolve().then(operation).then(resolve, reject); },
    };
    return query;
  }
  return { db, tables };
}
const settings = loadSource('src/config/dashboardOrigins.ts');
function originService(db, env = { NODE_ENV: 'production' }, overrides = {}) {
  return loadSource('src/app/services/dashboardOrigin.service.ts', {
    '@surefy/database': db,
    '@surefy/exceptions/CustomError': { CustomError: AppError },
    '../../config/dashboardOrigins': { ...settings, ...overrides },
  }, { process: { env } });
}

test('exact origins only; production rejects local HTTP, paths, userinfo and lookalikes', async () => {
  const { db } = memoryDb(), service = originService(db);
  for (const value of [undefined, null, 'null', 'app.soft7.in', 'https://app.soft7.in/',
    'https://app.soft7.in/path', 'https://app.soft7.in?x=1', 'https://app.soft7.in#x',
    'https://name@app.soft7.in', 'http://localhost:3001', 'javascript:alert(1)',
    'https://app.soft7.in.evil.test', 'https://dashboard.alpha.test:8443', 'https://unregistered.test']) {
    assert.equal(await service.isDashboardOriginAllowed(value, 'a'), false, String(value));
  }
  assert.equal(await service.requireDashboardOrigin('https://app.soft7.in', 'a'), 'https://app.soft7.in');
  await assert.rejects(service.requireDashboardOrigin('https://app.soft7.in', undefined));
});

test('registered company origins require active domain AND SSL; JWT tenant check is stricter than CORS', async () => {
  const { db } = memoryDb(), service = originService(db);
  assert.equal(await service.isDashboardOriginAllowed('https://dashboard.beta.test'), true);
  assert.equal(await service.isDashboardOriginAllowed('https://dashboard.beta.test', 'b'), true);
  await assert.rejects(service.requireDashboardOrigin('https://dashboard.beta.test', 'a'), e => e.statusCode === 403);
  for (const host of ['pending.test', 'ssl-pending.test']) assert.equal(await service.isDashboardOriginAllowed(`https://${host}`, 'a'), false);
  assert.equal(await service.isDashboardOriginAllowed('https://dashboard.alpha.test', 'a'), true);
});

test('code-managed domains preserve company scope; development origins never enabled in production', async () => {
  const { db } = memoryDb();
  const service = originService(db, { NODE_ENV: 'production' }, {
    companyDashboardOrigins: [{ companyId: 'a', origin: 'https://code.alpha.test' }],
  });
  assert.equal(await service.isDashboardOriginAllowed('https://code.alpha.test'), true);
  assert.equal(await service.isDashboardOriginAllowed('https://code.alpha.test', 'a'), true);
  assert.equal(await service.isDashboardOriginAllowed('https://code.alpha.test', 'b'), false);
  assert.equal(await service.isDashboardOriginAllowed(settings.developmentDashboardOrigins[2]), false);
  assert.equal(await originService(db, { NODE_ENV: 'development' }).isDashboardOriginAllowed('http://localhost:3001', 'a'), true);
});

test('callback rejects legacy sessions and domains revoked after OAuth start', async () => {
  const { db, tables } = memoryDb(), service = originService(db);
  await assert.rejects(service.sessionDashboardOrigin({ company_id: 'a' }), e => e.statusCode === 409);
  const session = { company_id: 'a', frontend_origin: 'https://dashboard.alpha.test' };
  assert.equal(await service.sessionDashboardOrigin(session), session.frontend_origin);
  tables.company_domains[0].status = 'inactive';
  await assert.rejects(service.sessionDashboardOrigin(session), e => e.statusCode === 403);
});

test('Facebook leads and messaging store origin at start and return only to that session origin', async () => {
  const { db, tables } = memoryDb(), origins = originService(db);
  const env = {
    NODE_ENV: 'production', FACEBOOK_PUBLIC_URL: 'https://api.test', FACEBOOK_GRAPH_VERSION: 'v23.0',
    FACEBOOK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    FACEBOOK_FRONTEND_URL: 'https://ignored.example',
  };
  for (const prefix of ['FACEBOOK_LEADS', 'FACEBOOK_MESSENGER']) Object.assign(env, {
    [`${prefix}_APP_ID`]: '123', [`${prefix}_APP_SECRET`]: 'x'.repeat(32),
    [`${prefix}_LOGIN_CONFIG_ID`]: '456', [`${prefix}_WEBHOOK_VERIFY_TOKEN`]: 'x'.repeat(32),
  });
  const model = loadSource('src/app/models/facebookOauthSession.model.ts', { '@surefy/database': db }).default;
  const service = loadSource('src/app/services/facebookOAuth.service.ts', {
    '@surefy/database': db,
    '@surefy/exceptions/CustomError': { CustomError: AppError },
    '../models/facebookOauthSession.model': model,
    './dashboardOrigin.service': origins,
  }, { process: { env } }).default;
  const scope = { companyId: 'a', ownerId: 'owner', userId: 'owner' };
  await assert.rejects(service.start('leads', scope, 'https://dashboard.beta.test'), e => e.statusCode === 403);
  for (const feature of ['leads', 'messaging']) {
    const result = await service.start(feature, scope, 'https://dashboard.alpha.test');
    const session = tables[feature === 'leads' ? 'facebook_lead_oauth_sessions' : 'facebook_oauth_sessions'][0];
    assert.equal(session.frontend_origin, 'https://dashboard.alpha.test');
    const authorization = new URL(result.authorizationUrl);
    assert.equal(new URL(authorization.searchParams.get('redirect_uri')).origin, 'https://api.test');
    const input = { state: authorization.searchParams.get('state'), denied: true,
      cookieHeader: `${result.cookieName}=${result.browser}`, frontend_origin: 'https://evil.test' };
    await assert.rejects(service[feature === 'leads' ? 'leadsCallback' : 'messagingCallback']({
      ...input, cookieHeader: `${result.cookieName}=${'x'.repeat(43)}`,
    }), e => e.statusCode === 409);
    const redirect = new URL(await service[feature === 'leads' ? 'leadsCallback' : 'messagingCallback'](input));
    assert.equal(redirect.origin, 'https://dashboard.alpha.test');
    assert.equal(redirect.searchParams.get('oauth'), 'failed');
    await assert.rejects(service[feature === 'leads' ? 'leadsCallback' : 'messagingCallback'](input), e => e.statusCode === 409);
  }
});

test('migration adds nullable origins to all three session tables without modifying existing rows', async () => {
  const knex = require('knex')({ client: 'pg' });
  const statements = [];
  const migration = loadSource('src/database/migrations/20261106000001_oauth_frontend_origin.ts');
  await migration.up({ schema: { alterTable(name, callback) {
    statements.push(...knex.schema.alterTable(name, callback).toSQL().map(query => query.sql));
    return Promise.resolve();
  } } });
  assert.equal(statements.length, 3);
  for (const name of ['facebook_oauth_sessions', 'facebook_lead_oauth_sessions', 'instagram_oauth_sessions']) {
    assert.ok(statements.includes(`alter table "${name}" add column "frontend_origin" text null`));
  }
  await knex.destroy();
});

test('Instagram stores the same tenant-bound origin and returns it on cancellation', async () => {
  const { db, tables } = memoryDb(), origins = originService(db);
  const facebook = loadSource('src/app/utils/facebook.ts');
  const { InstagramService } = loadSource('src/app/services/instagram.service.ts', {
    '@surefy/database': db, './dashboardOrigin.service': origins, '../utils/facebook': facebook,
    './socialAccess.service': { requireSocialOwner: async () => {} },
    './instagramGraph.service': { directInstagramConfig: () => ({ appId: '123', callback: 'https://api.test/callback' }),
      directInstagramLoginScopes: ['instagram_business_basic'] },
  });
  const service = new InstagramService(db);
  const scope = { companyId: 'a', ownerId: 'owner', userId: 'owner' };
  await assert.rejects(service.start(scope, 'instagram', 'https://dashboard.beta.test'));
  const result = await service.start(scope, 'instagram', 'https://dashboard.alpha.test');
  assert.equal(tables.instagram_oauth_sessions[0].frontend_origin, 'https://dashboard.alpha.test');
  const callback = await service.callback(new URL(result.url).searchParams.get('state'), result.browser, undefined, true);
  assert.equal(callback.status, 'failed');
  assert.equal(new URL(facebook.frontendCallback(callback.frontendOrigin, 'instagram', callback.status)).origin, 'https://dashboard.alpha.test');
});

test('HTTP preflights allow registered dashboards with credentials and reject arbitrary origins', async t => {
  const { db } = memoryDb(), origins = originService(db);
  const { default: createApp } = loadSource('library/surefy/src/server.ts', {
    '@surefy/console/services/dashboardOrigin.service': origins,
    './middleware/requestCapacity': { requestCapacity: () => (_req, _res, next) => next() },
    './middleware/errorHandler': { errorHandler: (err, _req, res, _next) => res.status(503).end() },
    './routes/health.route': express.Router(),
    './middleware/upload.middleware': { UPLOADS_DIR: 'uploads' },
    './utils/asyncRouter': { protectAsyncRoutes() {} },
  }, { process: { env: { WORKER_MODE: 'true' } } });
  const app = createApp();
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/v1/admin/facebook/oauth/start', '/v1/admin/instagram/oauth/start']) {
    const response = await fetch(base + path, { method: 'OPTIONS', headers: {
      Origin: 'https://dashboard.alpha.test', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://dashboard.alpha.test');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('vary'), /Origin/);
    const denied = await fetch(base + path, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  }
});
