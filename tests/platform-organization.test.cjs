const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./helpers/background-database.cjs');
const platformId = '5a66df74-92d4-4bcd-814b-13d6318d4116';
const companyId = '1056a749-ea3d-4c1d-9798-a6882d9997f5';
const legacyId = 'ae815512-cf4b-4e7e-8472-16d3c2d4bb18';
const otherId = 'cc0fa7dd-ddca-4d0d-b23e-f797488951ef';
const helper = loadSource('src/app/utils/platformOrganization.ts');
class HttpError extends Error { constructor({ message }) { super(message); } }
function fixture() {
  const user = { id: platformId, company_id: companyId, role: 'superadmin', status: 'active' };
  const rows = {
    companies: [{ id: companyId, settings: { organization_type: 'platform', platform_admin_user_id: platformId,
      legacy_company_ids: [legacyId], legacy_login_domain_ids: ['login'], preferred_login_domain: 'superadmin.soft7.in' } },
      { id: legacyId }, { id: otherId }],
    users: [user],
    company_domains: [{ id: 'login', user_id: 'company-admin', company_id: legacyId, status: 'active', domain_name: 'superadmin.soft7.in' },
      { id: 'unapproved', company_id: legacyId, status: 'active', domain_name: 'unapproved.example' },
      { id: 'foreign', company_id: otherId, status: 'active', domain_name: 'foreign.example' }],
  };
  const db = table => {
    const predicates = [];
    const q = {
      where(value, expected) { predicates.push(typeof value === 'string' ? row => row[value] === expected
        : row => Object.entries(value).every(([key, expected]) => row[key] === expected)); return q; },
      andWhere(...args) { return q.where(...args); },
      whereNull(column) { predicates.push(row => row[column] == null); return q; },
      whereIn(column, values) { predicates.push(row => values.includes(row[column])); return q; },
      async first(...fields) {
        const row = rows[table].find(row => predicates.every(predicate => predicate(row)));
        if (!row || !fields.length) return row;
        return Object.fromEntries(fields.flat().filter(key => key in row).map(key => [key, row[key]]));
      },
    }; return q;
  };
  class BaseModel {
    constructor(table) { this.table = table; this.db = db; }
    query() { return db(this.table); }
    findOne(scope) { return this.query().where(scope).first(); }
  }
  return { db, rows, user, BaseModel };
}

test('historical company reads require both superadmin role and explicit organization ownership', async () => {
  const f = fixture();
  assert.deepEqual(Array.from(await helper.companyReadScope(f.db, f.user)), [companyId, legacyId]);
  assert.deepEqual(Array.from(await helper.companyReadScope(f.db, { ...f.user, role: 'admin' })), [companyId]);
  assert.deepEqual(Array.from(await helper.companyReadScope(f.db, { ...f.user, id: 'another-superadmin' })), [companyId]);
  assert.deepEqual(Array.from(await helper.companyReadScope(f.db, { ...f.user, company_id: legacyId })), [legacyId]);
  f.rows.companies[0].settings.legacy_company_ids.push('invalid');
  assert.deepEqual(Array.from(await helper.companyReadScope(f.db, f.user)), [companyId, legacyId]);
});

test('login preserves only approved active legacy domains without moving or duplicating them', async () => {
  const f = fixture(), before = JSON.stringify(f.rows);
  const model = loadSource('src/app/models/companyDomain.model.ts', {
    '@surefy/models/base.model': { BaseModel: f.BaseModel }, '../utils/platformOrganization': helper,
  }).default;
  assert.equal((await model.findLoginDomain(f.user, 'superadmin.soft7.in')).id, 'login');
  assert.equal((await model.findDefaultLoginDomain(f.user)).domain_name, 'superadmin.soft7.in');
  assert.equal(await model.findLoginDomain(f.user, 'unapproved.example'), undefined);
  assert.equal(await model.findLoginDomain(f.user, 'foreign.example'), undefined);
  assert.equal(await model.findLoginDomain({ ...f.user, role: 'admin' }, 'superadmin.soft7.in'), undefined);
  assert.equal(JSON.stringify(f.rows), before);
  f.rows.company_domains[0].status = 'inactive';
  assert.equal(await model.findLoginDomain(f.user, 'superadmin.soft7.in'), undefined);
});

test('superadmin historical company routes retain access while unrelated companies stay excluded', async () => {
  const f = fixture();
  const model = loadSource('src/app/models/superAdmin.model.ts', {
    '@surefy/models/base.model': { BaseModel: f.BaseModel }, '../utils/platformOrganization': helper,
    '@surefy/exceptions/HTTP404Error': HttpError,
  }).default;
  assert.equal((await model.user(platformId, legacyId)).company_id, companyId);
  assert.equal((await model.user(platformId, companyId)).company_id, companyId);
  await assert.rejects(model.user(platformId, otherId), /User not found/);
  f.user.role = 'admin';
  await assert.rejects(model.user(platformId, legacyId), /User not found/);
});

test('contact reads retain the same user owner across current and preserved company scopes', async () => {
  const f = fixture(), calls = [];
  const controller = loadSource('src/app/http/controllers/contact.controller.ts', {
    '@surefy/database': f.db, '../../utils/platformOrganization': helper,
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, _res, _message, data) => data },
    '@surefy/console/services/contact.service': { getContacts: async (...args) => { calls.push(args); return {}; } },
  }).default;
  await controller.getContacts({ userId: platformId, ownerId: platformId, userRole: 'superadmin', companyId, query: {} }, {});
  assert.equal(calls[0][0], platformId);
  assert.deepEqual(Array.from(calls[0][3]), [companyId, legacyId]);
  await controller.getContacts({ userId: 'company-admin', ownerId: 'company-admin', userRole: 'admin', companyId: legacyId, query: {} }, {});
  assert.equal(calls[1][3], legacyId);
});

test('separation rejects malformed IDs before any database access', async () => {
  const { separatePlatformCompany } = require('../scripts/separate-platform-company.cjs');
  await assert.rejects(separatePlatformCompany({ transaction() { assert.fail('Unexpected database access'); } }, { companyId: 'invalid' }), /UUID/);
});
