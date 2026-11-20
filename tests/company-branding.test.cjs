const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { loadSource } = require('./helpers/background-database.cjs');
class BadRequest extends Error { constructor({ message }) { super(message); this.statusCode = 400; } }
class NotFound extends Error { constructor({ message }) { super(message); this.statusCode = 404; } }
const http = loadSource('library/surefy/src/utils/Controller.ts');

test('company branding supports deployed POST and legacy GET and forwards validation/errors', async () => {
  const calls = [];
  const controller = loadSource('src/app/http/controllers/auth.controller.ts', {
    '@surefy/utils/Controller': http,
    '@surefy/exceptions/HTTP400Error': BadRequest,
    '@surefy/exceptions/HTTP404Error': NotFound,
    '../../models/company.model': { getCompanyDetails: async domain => {
      calls.push(domain);
      if (domain === 'missing.example.com') return undefined;
      if (domain === 'failed.example.com') throw new Error('Database failure');
      return { id: 'company', name: 'Brand', logo: null };
    } },
  }).default;
  const noop = (_req, _res, next) => next();
  const handlers = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false :
    key === 'getCompanyDetails' ? controller.getCompanyDetails : noop });
  const route = loadSource('src/routes/auth.route.ts', {
    '@surefy/console/http/controllers/auth.controller': handlers,
    '../app/http/controllers/team.controller': handlers,
    '../app/http/controllers/googleAuth.controller': { __esModule: true, default: handlers, googleAuthRequest: noop },
    '@surefy/middleware/jwtAuth.middleware': { jwtAuthMiddleware: noop, requireRole: () => noop },
    '@surefy/middleware/upload.middleware': { uploadMediaMiddleware: noop },
    '@surefy/utils/Controller': http,
  }).default;
  const app = express(); app.use(express.json()); app.use('/v1/auth', route);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/auth/company-details`;
  const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const domain_name of [undefined, '', null, [], 'https://app.example.com']) assert.equal((await post({ domain_name })).status, 400);
    assert.equal((await fetch(url)).status, 400); assert.equal(calls.length, 0);
    const result = await post({ domain_name: ' App.Example.com ' });
    assert.equal(result.status, 200); assert.equal((await result.json()).company.name, 'Brand');
    assert.equal(calls[0], 'app.example.com');
    assert.equal((await fetch(`${url}?domain_name=app.example.com`)).status, 200);
    assert.equal((await post({ domain_name: 'missing.example.com' })).status, 404);
    assert.equal((await post({ domain_name: 'failed.example.com' })).status, 500);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('public company lookup selects branding only and rejects inactive or ambiguous domains', async () => {
  let domains = [], companies = [], selected;
  class BaseModel {
    constructor() { this.db = () => ({ where() { return this; }, limit() { return this; }, select: async () => domains }); }
    query() { return {
      where() { return this; }, whereNull() { return this; }, select(columns) { selected = columns; return this; },
      first: async () => companies[0], limit: async () => companies,
    }; }
  }
  const model = loadSource('src/app/models/company.model.ts', { '@surefy/models/base.model': { BaseModel } }).default;
  companies = [{ id: 'company', name: 'Brand' }];
  domains = [{ company_id: 'company', status: 'active', ssl_status: 'active' }];
  assert.equal((await model.getCompanyDetails('app.example.com')).id, 'company');
  assert.deepEqual(Array.from(selected), ['id', 'name', 'logo', 'domain']);
  domains[0].ssl_status = 'pending'; assert.equal(await model.getCompanyDetails('app.example.com'), undefined);
  domains = [{ ...domains[0], ssl_status: 'active' }, { ...domains[0], ssl_status: 'active' }];
  assert.equal(await model.getCompanyDetails('app.example.com'), undefined);
  domains = []; assert.equal((await model.getCompanyDetails('legacy.example.com')).id, 'company');
  companies.push({ id: 'other' }); assert.equal(await model.getCompanyDetails('legacy.example.com'), undefined);
});
