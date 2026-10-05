const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const knex = require('knex');
const path = require('node:path');

function load(file, deps = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, require: id => Object.hasOwn(deps, id) ? deps[id] : require(id),
    process, Buffer, Date, URL, Error, console, setTimeout, clearTimeout,
    __dirname: path.dirname(path.resolve(file)), __filename: path.resolve(file) });
  return exports;
}
function configure() {
  Object.assign(process.env, {
    FACEBOOK_APP_ID: '10001', FACEBOOK_APP_SECRET: 'unit-test-app-secret', FACEBOOK_GRAPH_VERSION: 'v26.0',
    FACEBOOK_PUBLIC_URL: 'https://support.example.test', FACEBOOK_LOGIN_CONFIG_ID: '10002', FACEBOOK_LOGIN_MODE: 'business',
    FACEBOOK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), FACEBOOK_WEBHOOK_VERIFY_TOKEN: 'unit-test-verify',
    FACEBOOK_PRIVACY_CONTROLLER: 'Test Business', FACEBOOK_PRIVACY_EMAIL: 'privacy@example.test', JWT_SECRET: 'unit-test-jwt-secret',
  });
}
configure();
const utils = load('src/app/utils/facebook.ts');
const migration = load('src/database/migrations/20261003000002_create_facebook_messenger.ts');
const serviceModule = load('src/app/services/facebookMessenger.service.ts', {
  '@surefy/database': () => { throw new Error('Tests must inject their isolated database.'); },
  './facebookGraph.service': { default: {} }, '../utils/facebook': utils,
});

class MetaFixture {
  calls = [];
  grants = [...utils.permissions];
  candidates = [{ id: '20001', name: 'Review Test Page', access_token: 'TEST_PAGE_TOKEN', tasks: ['MESSAGING', 'MANAGE'] }];
  async authorize() { return { token: 'TEST_USER_TOKEN', userId: '30001', granted: this.grants, dataExpires: null }; }
  async pages() { return this.candidates; }
  async inspectPage() { return { name: 'Review Test Page', expires: null }; }
  async call(path, token, method = 'GET', params, body) {
    this.calls.push({ path, token, method, params, body });
    if (this.failure) throw this.failure;
    if (path.endsWith('/messages')) return { recipient_id: body.recipient.id, message_id: 'out-' + this.calls.length };
    if (method === 'GET') return { data: [{ id: process.env.FACEBOOK_APP_ID, subscribed_fields: utils.subscriptions }] };
    return { success: true };
  }
}

async function fixture(run) {
  const url = process.env.FACEBOOK_TEST_DATABASE_URL;
  if (!url) throw new Error('FACEBOOK_TEST_DATABASE_URL is required for PostgreSQL tests.');
  const target = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Facebook automated database tests require an isolated LOCAL PostgreSQL instance.');
  const schema = 'facebook_test_' + crypto.randomUUID().replaceAll('-', '');
  const admin = knex({ client: 'pg', connection: url });
  await admin.raw('CREATE SCHEMA ??', [schema]);
  const database = knex({ client: 'pg', connection: url, searchPath: [schema], pool: { min: 0, max: 8 } });
  try {
    await database.schema.createTable('companies', t => { t.uuid('id').primary(); t.string('status'); t.timestamp('deleted_at'); });
    await database.schema.createTable('users', t => { t.uuid('id').primary(); t.uuid('company_id'); t.string('status'); t.string('role'); t.string('email'); t.timestamp('deleted_at'); });
    await database.schema.createTable('user_team', t => { t.uuid('company_id'); t.uuid('invite_sent_by'); t.string('email'); t.string('invite_status'); t.jsonb('permission'); });
    await migration.up(database);
    const companyA = crypto.randomUUID(), companyB = crypto.randomUUID();
    const ownerA = crypto.randomUUID(), ownerB = crypto.randomUUID(), otherOwner = crypto.randomUUID(), memberId = crypto.randomUUID();
    await database('companies').insert([{ id: companyA, status: 'active' }, { id: companyB, status: 'active' }]);
    await database('users').insert([
      { id: ownerA, company_id: companyA, email: 'a@example.test', status: 'active', role: 'company' },
      { id: ownerB, company_id: companyB, email: 'b@example.test', status: 'active', role: 'company' },
      { id: otherOwner, company_id: companyA, email: 'other@example.test', status: 'active', role: 'company' },
      { id: memberId, company_id: companyA, email: 'member@example.test', status: 'active', role: 'company' },
    ]);
    const a = { companyId: companyA, ownerId: ownerA, userId: ownerA };
    const b = { companyId: companyB, ownerId: ownerB, userId: ownerB };
    const other = { companyId: companyA, ownerId: otherOwner, userId: otherOwner };
    const member = { companyId: companyA, ownerId: ownerA, userId: memberId };
    const meta = new MetaFixture();
    const service = new serviceModule.FacebookMessengerService(database, meta);
    async function connect(account = a, pageId = '20001') {
      const login = await service.start(account);
      const state = new URL(login.url).searchParams.get('state');
      await service.callback(state, login.browser, 'real-code-fixture', false);
      return service.connect(account, login.browser, pageId);
    }
    const inbound = (mid = 'in-1', text = 'Hello, I need help with my order.', timestamp = Date.now()) => ({ object: 'page', entry: [{ id: '20001', messaging: [{ sender: { id: '40001' }, recipient: { id: '20001' }, timestamp, message: { mid, text } }] }] });
    const echo = (mid, metadata, timestamp = Date.now(), text = 'Reply') => ({ object: 'page', entry: [{ id: '20001', messaging: [{ sender: { id: '20001' }, recipient: { id: '40001' }, timestamp, message: { mid, text, is_echo: true, metadata } }] }] });
    const receipt = (type, watermark, mids) => ({ object: 'page', entry: [{ id: '20001', messaging: [{ sender: { id: '40001' }, recipient: { id: '20001' }, [type]: { watermark, mids } }] }] });
    await run({ database, service, meta, a, b, other, member, connect, inbound, echo, receipt });
  } finally {
    await database.destroy(); await admin.raw('DROP SCHEMA ?? CASCADE', [schema]); await admin.destroy();
  }
}
module.exports = { load, configure, utils, migration, fixture, MetaFixture };
