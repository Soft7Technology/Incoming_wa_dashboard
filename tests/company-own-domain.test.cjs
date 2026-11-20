const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { prepareValue } = require('pg/lib/utils');
const { loadSource } = require('./helpers/background-database.cjs');

class HttpError extends Error {
  constructor(message, statusCode = 400, _operational = true, details) {
    super(typeof message === 'object' ? message.message : message);
    this.statusCode = statusCode;
    this.details = typeof message === 'object' ? message.details : details;
  }
}
const http = loadSource('library/surefy/src/utils/Controller.ts', {
  './HttpStatusCode': { HttpStatusCode: { OK: 200 } },
  './Response': { sendResponse: (res, status, success, message, data) => res.status(status).json({ success, message, data }) },
});

test('domain model sends validation arrays as JSONB through the actual base model and pg encoder', async () => {
  let captured;
  const base = loadSource('library/surefy/src/models/base.model.ts', {
    '../database': () => ({ where() { return this; }, update(value) { captured = value; return this; }, returning: async () => [captured] }),
  });
  const model = loadSource('src/app/models/companyDomain.model.ts', { '@surefy/models/base.model': base }).default;
  for (const records of [[], [{ type: 'txt', name: '_acme-challenge.example.com', value: 'verification' }]]) {
    const input = { ssl_validation_records: records, ownership_verification: { type: 'txt' } };
    await model.update('domain-id', input);
    assert.deepEqual(JSON.parse(prepareValue(captured.ssl_validation_records)), records);
    assert.deepEqual(JSON.parse(prepareValue(captured.ownership_verification)), input.ownership_verification);
    assert.equal(input.ssl_validation_records, records, 'input is not mutated');
  }
  await model.update('domain-id', { ssl_validation_records: null });
  assert.equal(captured.ssl_validation_records, null);
});

test('own-domain HTTP route validates input, normalizes hostnames, forwards errors and rejects GET', async () => {
  const lookups = [], calls = [];
  const controller = loadSource('src/app/http/controllers/company.controller.ts', {
    '@surefy/utils/Controller': http,
    '@surefy/exceptions/HTTP400Error': HttpError,
    '../../models/companyDomain.model': {
      findByDomain: async domain => { lookups.push(domain); return undefined; },
      findDomainByCompanyId: async () => undefined,
    },
    '@surefy/console/services/company.service': {
      createDomainName: async (...args) => {
        calls.push(args);
        if (args[2] === 'failed.example.com') throw new HttpError('Cloudflare unavailable', 502);
        return { domain_name: args[2], status: 'pending' };
      },
    },
  }).default;
  const handlers = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : key === 'createOwnDomain' ? controller.createOwnDomain
    : (_req, res) => res.status(418).json({ wrong_route: true }) });
  const route = loadSource('src/routes/company.route.ts', {
    '@surefy/console/http/controllers/company.controller': handlers,
    '@surefy/middleware/upload.middleware': { uploadMediaMiddleware: (_req, _res, next) => next() },
    '@surefy/middleware/jwtAuth.middleware': { requireRole: () => (_req, _res, next) => next() },
  }).default;
  const app = express();
  app.use(express.json(), (req, _res, next) => { req.userId = 'user'; req.companyId = 'company'; next(); });
  app.use('/companies', route);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/companies/own-domain`;
  const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const domain of [undefined, null, '', 42, {}, 'https://example.com', 'app.example.com/path', 'app example.com']) {
      assert.equal((await post({ domain_name: domain })).status, 400);
    }
    assert.equal(lookups.length, 0);
    assert.equal((await post({ domain_name: ' App.Example.com ' })).status, 200);
    assert.equal(calls[0][2], 'app.example.com');
    assert.equal((await post({ domain_name: 'failed.example.com' })).status, 502);
    const get = await fetch(url);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function serviceFixture({ token = 'test-token', postError, getError, dbError } = {}) {
  const writes = [], providerCalls = [], logs = [];
  const domain = { id: 'domain', domain_name: 'app.example.com' };
  const details = { id: 'cloudflare-hostname', hostname: domain.domain_name, status: 'pending',
    ssl: { status: 'pending_validation', validation_records: [{ txt_name: '_acme-challenge.example.com', txt_value: 'verification' }] } };
  const service = loadSource('src/app/services/company.service.ts', {
    '@surefy/exceptions/CustomError': { CustomError: HttpError },
    '../models/companyDomain.model': {
      create: async data => { writes.push(data); return domain; },
      getCompanyDomainById: async () => domain,
      update: async (_id, data) => { if (dbError) throw dbError; writes.push(data); return data; },
    },
    axios: {
      post: async (...args) => { providerCalls.push(args); if (postError) throw postError; return { data: { success: true, result: { id: details.id } } }; },
      get: async (...args) => { providerCalls.push(args); if (getError) throw getError; return { data: { success: true, result: details } }; },
    },
  }, { process: { env: { CLOUDFLARE_API_TOKEN: token } }, console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) } }).default;
  return { service, writes, providerCalls, logs };
}

test('own-domain service returns domain details and does not log the provider token', async () => {
  const f = serviceFixture();
  assert.equal((await f.service.createDomainName('user', 'company', 'app.example.com')).id, 'domain');
  assert.equal(f.providerCalls.length, 2);
  for (const call of f.providerCalls) assert.equal(call.at(-1).timeout, 15000);
  assert.equal(f.writes[1].ssl_validation_records[0].name, '_acme-challenge.example.com');
  assert.equal(JSON.stringify(f.logs).includes('test-token'), false);
});

test('missing Cloudflare configuration fails before inserting a domain', async () => {
  const f = serviceFixture({ token: '' });
  await assert.rejects(f.service.createDomainName('user', 'company', 'app.example.com'), error =>
    error.statusCode === 503 && error.details.code === 'CLOUDFLARE_NOT_CONFIGURED');
  assert.equal(f.writes.length, 0);
  assert.equal(f.providerCalls.length, 0);
});

test('Cloudflare failures keep useful status and codes without exposing credentials', async () => {
  const providerError = { response: { status: 403, data: { errors: [{ code: 10000, message: 'provider detail' }] } },
    config: { headers: { Authorization: 'Bearer secret-token' } } };
  for (const options of [{ postError: providerError }, { getError: providerError }, { postError: new Error('timeout secret-token') }]) {
    const f = serviceFixture(options);
    await assert.rejects(f.service.createDomainName('user', 'company', 'app.example.com'), error => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.details.code, 'CLOUDFLARE_DOMAIN_REQUEST_FAILED');
      assert.equal(JSON.stringify(error).includes('secret-token'), false);
      return true;
    });
    assert.equal(f.logs.length, 0);
  }
});

test('database errors retain their identity for the central database error handler', async () => {
  const failure = Object.assign(new Error('database unavailable'), { code: '08006' });
  const f = serviceFixture({ dbError: failure });
  await assert.rejects(f.service.createDomainName('user', 'company', 'app.example.com'), error => error === failure);
});
