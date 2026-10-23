const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function loadSource(file, dependencies, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => {
    if (id in dependencies) return dependencies[id];
    throw Error('Missing test dependency: ' + id);
  }, console, ...globals }, { filename: file });
  return exports;
}

class BadRequest extends Error { constructor({ message }) { super(message); this.statusCode = 400; } }
const input = { user_id: 'owner', company_id: 'company', waba_id: '123456' };

function fixture(options = {}) {
  const calls = [], logs = [];
  let account = options.account;
  const model = {
    async findByWabaId() { return account; },
    async upsertOwnedAccount(data) {
      account = { ...account, ...data, id: account?.id || '00000000-0000-4000-8000-000000000003', connection_status: account?.connection_status || 'legacy' };
      return account;
    },
    async findOwnedForSync() { return account; },
    async syncAccountAndPhones(waba, details, phones) {
      calls.push('save-phones');
      if (options.phoneConflict) throw new BadRequest({ message: 'Phone belongs to another account' });
      const saved = phones.slice(0, options.remaining ?? phones.length);
      const skipped = phones.slice(saved.length).map(phone => ({ phone_number_id: phone.id, reason: 'PLAN_LIMIT_EXCEEDED' }));
      return { waba, phone_numbers: saved.map(phone => ({ ...phone, phone_number_id: phone.id })),
        total_phone_numbers: phones.length, created: saved.length, updated: 0,
        skipped_count: skipped.length, skipped_phone_numbers: skipped, remaining_slots: 0 };
    },
  };
  const meta = {
    async getWabaDetails() {
      calls.push('details');
      if (options.metaFailure) throw Error('Meta unavailable');
      return { id: input.waba_id, name: 'Business' };
    },
    async getPhoneNumbers() { calls.push('phones'); return { data: options.phones ?? [{ id: '1001', display_phone_number: '+1 555 0101' }] }; },
    async subscribeToWebhooks() {
      calls.push('webhook');
      if (options.webhookFailure) throw Error('Webhook subscription failed');
      return { success: true };
    },
  };
  const service = loadSource('src/app/services/waba.service.ts', {
    '@surefy/console/models/waba.model': model,
    '@surefy/console/models/phoneNumber.model': {},
    '@surefy/console/services/meta.service': meta,
    '@surefy/exceptions/HTTP400Error': BadRequest,
    '@surefy/exceptions/HTTP404Error': BadRequest,
    axios: {}, '../models/activityLogs.model': { async create(data) { logs.push(data); } },
    '../models/contactList.model': {}, '../models/importJob.model': {},
    uuid: require('uuid'), './planUsage.service': {},
    './wabaCredentials.service': { async forAccount() { return null; } },
    './wabaGraph.service': { WabaGraph: class { constructor() { throw Error('No OAuth setup is needed'); } } },
    '../utils/wabaOnboarding': {},
    './template.service': { async syncTemplates() {
      calls.push('templates'); if (options.templateFailure) throw Error('Template sync failed'); return [];
    } },
  }, { Date }).default;
  const controller = loadSource('src/app/http/controllers/waba.controller.ts', {
    '@surefy/utils/Controller': {
      tryCatchAsync: fn => fn,
      successResponse: (_req, res, message, data, status) => res.status(status).json({ success: true, message, data }),
    },
    '@surefy/utils/HttpStatusCode': { HttpStatusCode: { CREATED: 201 } },
    '@surefy/console/services/waba.service': service,
    '@surefy/exceptions/HTTP400Error': BadRequest,
  }).default;
  return { service, controller, calls, logs };
}

test('onboard accepts only the WABA ID and completes synchronously with trusted owner/company', async () => {
  const f = fixture();
  const res = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await f.controller.onboardingWaba({ ownerId: input.user_id, userId: 'member', companyId: input.company_id,
    body: { waba_id: input.waba_id, user_id: 'attacker', company_id: 'attacker', code: 'ignored', state: 'ignored' } }, res);
  assert.equal(res.statusCode, 201);
  const data = res.body.data.data;
  assert.equal(data.clientWabaAccount.user_id, input.user_id);
  assert.equal(data.clientWabaAccount.company_id, input.company_id);
  assert.equal(data.clientWabaAccount.code, undefined);
  assert.equal(data.phoneNumbers[0].phone_number_id, '1001');
  assert.equal(data.webhook.success, true);
  assert.deepEqual(f.calls, ['details', 'details', 'phones', 'save-phones', 'webhook', 'templates']);
  assert.equal(f.logs[0].status, 'SUCCESS');
});

test('onboard reports a missing ID using the existing HTTP 400 error', async () => {
  for (const body of [undefined, {}, { code: 'old-code' }]) {
    const f = fixture();
    await assert.rejects(f.controller.onboardingWaba({ body }, {}), error => error.statusCode === 400 && error.message === 'WABA ID is required');
    assert.equal(f.calls.length, 0);
  }
});

test('repeated WABA onboarding retains its local account ID and supports no phone numbers', async () => {
  const f = fixture({ phones: [] });
  const first = await f.service.onboardWaba(input);
  const second = await f.service.onboardWaba(input);
  assert.equal(first.data.clientWabaAccount.id, second.data.clientWabaAccount.id);
  assert.equal(second.data.phoneNumbers.length, 0);
});

test('onboard keeps the phone array compatible and exposes skipped-number quota details', async () => {
  const f = fixture({ remaining: 1, phones: [{ id: '1001', display_phone_number: '+1 555 0101' }, { id: '1002', display_phone_number: '+1 555 0102' }] });
  const result = await f.service.onboardWaba(input);
  assert.equal(result.data.phoneNumbers.length, 1);
  assert.equal(result.data.phone_number_sync.total_phone_numbers, 2);
  assert.equal(result.data.phone_number_sync.created, 1);
  assert.equal(result.data.phone_number_sync.skipped_count, 1);
  assert.equal(result.data.phone_number_sync.skipped_phone_numbers[0].phone_number_id, '1002');
  assert.equal(result.data.phone_number_sync.remaining_slots, 0);
});

test('invalid IDs and foreign WABA ownership fail before Meta calls', async () => {
  for (const waba_id of [null, {}, 123456, '123/phone_numbers']) {
    const f = fixture();
    await assert.rejects(f.service.onboardWaba({ ...input, waba_id }), error => error.statusCode === 400);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ account: { id: 'foreign', user_id: 'someone-else', company_id: 'other-company' } });
  await assert.rejects(f.service.onboardWaba(input), /already connected to another account/);
  assert.equal(f.calls.length, 0);
});

test('Meta, phone ownership and webhook failures do not return a successful onboarding', async () => {
  for (const options of [{ metaFailure: true }, { phoneConflict: true }, { webhookFailure: true }]) {
    const f = fixture(options);
    await assert.rejects(f.service.onboardWaba(input));
    assert.ok(!f.calls.includes('templates'));
    assert.equal(f.logs.length, 0);
  }
});

test('template failure returns an error and repeating the request finishes setup', async () => {
  const options = { templateFailure: true }, f = fixture(options);
  await assert.rejects(f.service.onboardWaba(input), /Template sync failed/);
  assert.ok(f.calls.includes('webhook')); assert.equal(f.logs.length, 0);
  options.templateFailure = false;
  const result = await f.service.onboardWaba(input);
  assert.equal(result.data.clientWabaAccount.id, '00000000-0000-4000-8000-000000000003');
  assert.equal(f.logs.length, 1);
});

test('upsert preserves optional metadata absent from Meta', async () => {
  const f = fixture({ account: { ...input, id: '00000000-0000-4000-8000-000000000003', currency: 'INR', timezone: 'Asia/Kolkata',
    message_template_namespace: 'existing-namespace', meta_data: { retained: true } } });
  const result = await f.service.onboardWaba(input);
  assert.equal(result.data.clientWabaAccount.currency, 'INR');
  assert.equal(result.data.clientWabaAccount.timezone, 'Asia/Kolkata');
  assert.equal(result.data.clientWabaAccount.message_template_namespace, 'existing-namespace');
  assert.equal(result.data.clientWabaAccount.meta_data.retained, true);
});

test('WABA transport exposes no code exchange method or redirect parameter', async () => {
  const calls = [];
  const { WabaGraph } = loadSource('src/app/services/wabaGraph.service.ts', {
    axios: { request: async config => { calls.push(config); return { data: { id: '123456', name: 'Business' } }; } },
    crypto: require('node:crypto'), '../utils/wabaOnboarding': { WabaOnboardingError: Error,
      wabaConfig: () => ({ appId: '999', appSecret: 'fake-secret', version: 'v25.0' }) },
  });
  const graph = new WabaGraph('fake-token'); assert.equal(graph.exchange, undefined);
  assert.equal((await graph.getWabaDetails('123456')).id, '123456');
  assert.ok(!calls[0].url.includes('oauth/access_token'));
  for (const field of ['redirect_uri', 'code', 'client_secret']) assert.equal(calls[0].params[field], undefined);
});

test('PostgreSQL upsert preserves the UUID and cannot transfer another tenant account',
  { skip: process.env.WABA_ONBOARD_DATABASE_TEST !== 'true' }, async () => {
    require('dotenv').config({ quiet: true }); require('ts-node/register');
    const config = require('../library/surefy/src/config/knex.config').default.development;
    const db = require('knex')({ ...config, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });
    const schema = 'waba_simple_test_' + require('node:crypto').randomUUID().replaceAll('-', '');
    const marker = Error('ROLLBACK_SIMPLE_WABA_TEST');
    try {
      await assert.rejects(db.transaction(async trx => {
        await trx.schema.createSchema(schema); await trx.raw('SET LOCAL search_path TO ??', [schema]);
        await trx.schema.createTable('waba_accounts', t => {
          t.uuid('id').primary().defaultTo(trx.raw('gen_random_uuid()')); t.text('user_id'); t.text('company_id');
          t.text('waba_id').unique(); t.text('name'); t.text('currency'); t.text('timezone'); t.text('message_template_namespace');
          t.jsonb('meta_data'); t.timestamp('deleted_at'); t.timestamp('updated_at'); t.text('connection_status').defaultTo('legacy');
        });
        class BaseModel { query() { return trx('waba_accounts'); } }
        const model = loadSource('src/app/models/waba.model.ts', {
          '@surefy/models/base.model': { BaseModel }, '@surefy/exceptions/HTTP400Error': BadRequest,
          '@surefy/exceptions/HTTP404Error': BadRequest, '../services/planUsage.service': {},
        }, { Date }).default;
        const data = { ...input, name: 'Business', currency: 'INR', timezone: 'Asia/Kolkata', message_template_namespace: null,
          meta_data: { name: 'Business' }, deleted_at: null, updated_at: new Date() };
        const first = await model.upsertOwnedAccount(data);
        const [second, third] = await Promise.all([model.upsertOwnedAccount(data), model.upsertOwnedAccount({ ...data, name: 'Updated' })]);
        assert.equal(second.id, first.id); assert.equal(third.id, first.id);
        assert.equal(Number((await trx('waba_accounts').count('* as total').first()).total), 1);
        await assert.rejects(model.upsertOwnedAccount({ ...data, user_id: 'attacker', company_id: 'other-company' }), /another account/);
        const saved = await trx('waba_accounts').first();
        assert.equal(saved.user_id, input.user_id); assert.equal(saved.company_id, input.company_id);
        assert.equal(saved.meta_data.name, 'Business');
        throw marker;
      }), error => error === marker);
    } finally { await db.destroy(); }
  });
