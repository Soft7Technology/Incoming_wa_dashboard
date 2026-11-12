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
class WabaError extends Error {
  constructor(code, message, retryable, statusCode) { super(message); Object.assign(this, { code, retryable, statusCode }); }
}
const input = { user_id: 'owner', company_id: 'company', waba_id: '123456' };

function fixture(options = {}) {
  const calls = [], logs = [], selections = [];
  let account = options.account;
  const model = {
    async create(data) {
      calls.push('create');
      if (options.createFailure) throw Error('Database unavailable');
      account = { ...data, id: 'local-id', connection_status: 'legacy' };
      return account;
    },
    async saveSecondaryTokenSource(row) {
      calls.push('save-token-source');
      account = { ...row, meta_data: { ...row.meta_data, meta_token_source: 'secondary' } };
      return account;
    },
    async findByWabaId() { return account; },
    async upsertOwnedAccount(data) {
      account = { ...account, ...data, id: account?.id || '00000000-0000-4000-8000-000000000003', connection_status: account?.connection_status || 'legacy' };
      return account;
    },
    async findOwnedForSync() { return account; },
    async saveMessagingLimit(waba, tier) {
      calls.push('save-limit');
      if (options.deletedDuringRefresh) throw new BadRequest({ message: 'WABA not found in your account' });
      account = { ...account, whatsapp_business_manager_messaging_limit: tier, messaging_limit_synced_at: new Date() };
      return account;
    },
    async syncAccountAndPhones(waba, details, phones) {
      calls.push('save-phones');
      if (options.phoneConflict) throw new BadRequest({ message: 'Phone belongs to another account' });
      const saved = phones.slice(0, options.remaining ?? phones.length);
      const skipped = phones.slice(saved.length).map(phone => ({ phone_number_id: phone.id, reason: 'PLAN_LIMIT_EXCEEDED' }));
      return { waba, phone_numbers: saved.map(phone => ({ ...phone, phone_number_id: phone.id, meta_data: phone })),
        total_phone_numbers: phones.length, created: saved.length, updated: 0,
        skipped_count: skipped.length, skipped_phone_numbers: skipped, remaining_slots: 0 };
    },
  };
  const meta = {
    async withAccountToken(savedToken, newAccount, operation) {
      calls.push('select-token');
      selections.push({ savedToken, newAccount });
      return operation(meta, options.secondary === true);
    },
    async verifyOnboardingWebhooks(coexistence) {
      calls.push(coexistence ? 'verify-coexistence-webhooks' : 'verify-webhooks');
      if (options.badCallback) throw Error('Secondary webhook configuration missing');
    },
    async getWabaMessagingLimit(id) {
      calls.push('legacy-limit');
      assert.equal(id, input.waba_id);
      if (options.metaFailure) throw Error('Meta unavailable');
      return options.limitResponse ?? { id, whatsapp_business_manager_messaging_limit: 'TIER_2K' };
    },
    async getWabaDetails() {
      calls.push('details');
      if (options.metaFailure) throw Error('Meta unavailable');
      return options.detailsResponse ?? { id: input.waba_id, name: 'Business' };
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
    './wabaCredentials.service': { async forAccount(userId, companyId, id) {
      assert.equal(userId, input.user_id); assert.equal(companyId, input.company_id); assert.equal(id, account.id);
      if (options.credentialFailure) throw Error('Authorization expired');
      return options.token ?? null;
    } },
    './wabaGraph.service': { WabaGraph: class {
      constructor(token) { assert.equal(token, options.token); }
      async getWabaMessagingLimit(id) {
        calls.push('account-limit');
        assert.equal(id, input.waba_id);
        return options.limitResponse ?? { id, whatsapp_business_manager_messaging_limit: 'TIER_10K' };
      }
    } },
    '../utils/wabaOnboarding': { WabaOnboardingError: WabaError },
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
  return { service, controller, calls, logs, selections, get account() { return account; } };
}

const limitAccount = () => ({ ...input, id: '00000000-0000-4000-8000-000000000003', connection_status: 'legacy',
  whatsapp_business_manager_messaging_limit: 'TIER_250', messaging_limit_synced_at: new Date('2026-11-01T00:00:00Z') });

test('add account uses fallback validation and persists only the server-selected credential reference', async () => {
  for (const secondary of [false, true]) {
    const f = fixture({ secondary });
    const result = await f.service.createWaba({ ...input, meta_data: { label: 'Customer', meta_token_source: 'attacker' } });
    assert.equal(result.meta_data.meta_token_source, secondary ? 'secondary' : undefined);
    assert.equal(result.meta_data.label, 'Customer');
    assert.equal(result.name, 'Business');
    assert.deepEqual(f.calls, ['select-token', 'details', 'create']);
  }
});

test('add account rejects invalid IDs, duplicates and failed Meta validation before inserting', async () => {
  for (const options of [{ account: limitAccount() }, { metaFailure: true }, { detailsResponse: { id: '999' } }]) {
    const f = fixture(options);
    await assert.rejects(f.service.createWaba(input));
    assert.ok(!f.calls.includes('create'));
  }
  for (const id of ['', '123/phone_numbers', 123, {}]) {
    const f = fixture();
    await assert.rejects(f.service.createWaba({ ...input, waba_id: id }));
    assert.deepEqual(f.calls, []);
  }
  const f = fixture({ createFailure: true, secondary: true });
  await assert.rejects(f.service.createWaba(input));
  assert.deepEqual(f.calls, ['select-token', 'details', 'create'], 'database errors cannot retry the account insertion');
});

test('messaging limit refresh saves Meta tier and reads the cached result without another upstream call', async () => {
  const f = fixture({ account: limitAccount() });
  const result = await f.service.refreshMessagingLimit(input.user_id, input.company_id, input.waba_id);
  assert.equal(result.whatsapp_business_manager_messaging_limit, 'TIER_2K');
  assert.ok(result.messaging_limit_synced_at > new Date('2026-11-01T00:00:00Z'));
  const saved = await f.service.getMessagingLimit(input.user_id, input.company_id, result.id);
  assert.equal(saved.whatsapp_business_manager_messaging_limit, 'TIER_2K');
  assert.deepEqual(f.calls, ['legacy-limit', 'save-limit']);
});

test('messaging limit uses saved account credentials and accepts an internal UUID', async () => {
  const account = { ...limitAccount(), connection_status: 'connected' };
  const f = fixture({ account, token: 'account-token' });
  const result = await f.service.refreshMessagingLimit(input.user_id, input.company_id, account.id);
  assert.equal(result.whatsapp_business_manager_messaging_limit, 'TIER_10K');
  assert.deepEqual(f.calls, ['account-limit', 'save-limit']);
});

test('messaging limit rejects foreign, deleted and missing accounts before using Meta', async () => {
  for (const account of [undefined, { ...limitAccount(), user_id: 'other' },
    { ...limitAccount(), company_id: 'other' }, { ...limitAccount(), deleted_at: new Date() }]) {
    const f = fixture({ account });
    await assert.rejects(f.service.refreshMessagingLimit(input.user_id, input.company_id, input.waba_id), /not found/);
    await assert.rejects(f.service.getMessagingLimit(input.user_id, input.company_id, input.waba_id), /not found/);
    assert.deepEqual(f.calls, []);
  }
});

test('invalid IDs cannot become Graph paths', async () => {
  const f = fixture({ account: limitAccount() });
  for (const id of ['', '123/phone_numbers', '123?fields=access_token', {}, 123]) {
    await assert.rejects(f.service.refreshMessagingLimit(input.user_id, input.company_id, id), /wabaId/);
  }
  assert.deepEqual(f.calls, []);
});

test('absent or malformed Meta limit never overwrites the saved tier or timestamp', async () => {
  for (const limitResponse of [{ id: input.waba_id }, { id: '999', whatsapp_business_manager_messaging_limit: 'TIER_2K' },
    ...[null, 2000, '', 'TIER_2K\n', '<script>'].map(value => ({ id: input.waba_id, whatsapp_business_manager_messaging_limit: value }))]) {
    const account = limitAccount(), f = fixture({ account, limitResponse });
    await assert.rejects(f.service.refreshMessagingLimit(input.user_id, input.company_id, input.waba_id), error => error.statusCode === 502);
    const saved = await f.service.getMessagingLimit(input.user_id, input.company_id, input.waba_id);
    assert.equal(saved.whatsapp_business_manager_messaging_limit, 'TIER_250');
    assert.equal(saved.messaging_limit_synced_at, account.messaging_limit_synced_at);
    assert.ok(!f.calls.includes('save-limit'));
  }
});

test('expired/missing account credentials do not fall back to global credentials', async () => {
  for (const options of [{ credentialFailure: true }, { account: { ...limitAccount(), connection_status: 'connected' } }]) {
    const f = fixture({ account: limitAccount(), ...options });
    await assert.rejects(f.service.refreshMessagingLimit(input.user_id, input.company_id, input.waba_id));
    assert.deepEqual(f.calls, []);
  }
});

test('Meta failure and deletion during refresh cannot report a successful saved limit', async () => {
  for (const options of [{ metaFailure: true }, { deletedDuringRefresh: true }]) {
    const f = fixture({ account: limitAccount(), ...options });
    await assert.rejects(f.service.refreshMessagingLimit(input.user_id, input.company_id, input.waba_id));
    assert.equal((await f.service.getMessagingLimit(input.user_id, input.company_id, input.waba_id)).whatsapp_business_manager_messaging_limit, 'TIER_250');
  }
});

test('never-refreshed accounts return null and frontend cannot set the tier or owner', async () => {
  const account = limitAccount(); delete account.whatsapp_business_manager_messaging_limit; delete account.messaging_limit_synced_at;
  const f = fixture({ account });
  assert.equal((await f.service.getMessagingLimit(input.user_id, input.company_id, input.waba_id)).whatsapp_business_manager_messaging_limit, null);
  const res = { status() { return this; }, json(body) { this.body = body; return this; } };
  await f.controller.refreshMessagingLimit({ ownerId: input.user_id, userId: 'member', companyId: input.company_id,
    params: { wabaId: input.waba_id }, body: { user_id: 'attacker', whatsapp_business_manager_messaging_limit: 'TIER_UNLIMITED' } }, res);
  assert.equal(res.body.data.whatsapp_business_manager_messaging_limit, 'TIER_2K');
});

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
  assert.deepEqual(f.calls, ['select-token', 'details', 'details', 'phones', 'save-phones', 'webhook', 'templates']);
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

test('secondary onboarding verifies coexistence webhooks and remembers the app before template sync', async () => {
  const options = { secondary: true, phones: [{ id: '1001', display_phone_number: '+15550101', is_on_biz_app: true }] };
  const f = fixture(options);
  const result = await f.service.onboardWaba(input);
  assert.equal(result.data.clientWabaAccount.meta_data.meta_token_source, 'secondary');
  assert.ok(f.calls.indexOf('verify-coexistence-webhooks') < f.calls.indexOf('webhook'));
  assert.ok(f.calls.indexOf('save-token-source') < f.calls.indexOf('templates'));
  assert.ok(!JSON.stringify(result).includes('access_token'));
});

test('new onboarding selects the new app and retry keeps its source after webhook verification fails', async () => {
  const f = fixture({ secondary: true, badCallback: true });
  await assert.rejects(f.service.onboardWaba(input));
  assert.equal(f.selections[0].newAccount, true);
  assert.equal(f.account.meta_data.meta_token_source, 'secondary');
  await assert.rejects(f.service.onboardWaba(input));
  assert.equal(f.selections[1].newAccount, false);
});

test('existing onboarding never asks for the new-account app', async () => {
  const f = fixture({ account: limitAccount() });
  await f.service.onboardWaba(input);
  assert.equal(f.selections[0].newAccount, false);
});

test('a wrong secondary callback stops before subscription or credential persistence', async () => {
  const f = fixture({ secondary: true, badCallback: true });
  await assert.rejects(f.service.onboardWaba(input), /configuration missing/);
  assert.ok(!f.calls.includes('webhook'));
  assert.ok(!f.calls.includes('save-token-source'));
});

test('customer credentials missing from an existing connected account cannot trigger server-token onboarding', async () => {
  const f = fixture({ account: { ...limitAccount(), connection_status: 'connected' } });
  await assert.rejects(f.service.onboardWaba(input), e => e.code === 'WABA_SETUP_REQUIRED');
  assert.deepEqual(f.calls, []);
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
