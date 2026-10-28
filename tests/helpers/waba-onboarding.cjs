const crypto = require('node:crypto');
const { loadSource } = require('./background-database.cjs');
class CustomError extends Error {
  constructor(message, statusCode, operational, details) { super(message); Object.assign(this, { statusCode, isOperational: operational, details }); }
}
const env = { META_APP_ID: '999', META_APP_SECRET: 'test-app-secret', META_API_VERSION: 'v25.0',
  WABA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  WABA_WEBHOOK_CALLBACK_URL: 'https://test.example/v1/webhooks/meta', META_WEBHOOK_VERIFY_TOKEN: 'verify-test' };
class BadRequest extends Error { constructor({ message }) { super(message); this.statusCode = 400; this.isOperational = true; } }
const utils = loadSource('src/app/utils/wabaOnboarding.ts', { crypto, '@surefy/exceptions/CustomError': { CustomError }, '@surefy/exceptions/HTTP400Error': BadRequest }, { process: { env }, Buffer, Date });
const model = loadSource('src/app/models/wabaOnboarding.model.ts', { '@surefy/database': {}, crypto,
  '../utils/wabaOnboarding': utils }, { Date });
const owner = { userId: '00000000-0000-4000-8000-000000000001', companyId: '00000000-0000-4000-8000-000000000002' };
const code = 'SECRET-AUTHORIZATION-CODE-DO-NOT-LOG';
const token = 'SECRET-META-ACCESS-TOKEN-DO-NOT-LOG';
const connectedPhone = (changes = {}) => ({ id: '1001', phone_number_id: '1001', display_phone_number: '+1 555 010 1001',
  is_on_biz_app: false, platform_type: 'CLOUD_API', status: 'CONNECTED', code_verification_status: 'VERIFIED', ...changes });

function fixture(options = {}) {
  const rows = new Map(), calls = [], counts = { exchanges: 0, registers: 0, subscribes: 0, syncs: 0 };
  const inventories = options.inventories || { '111': [connectedPhone()] };
  const repo = {
    async reserve(scope, input) {
      if (options.invalidState && input.state) throw new utils.WabaOnboardingError('SIGNUP_STATE_INVALID', 'State expired', false, 403);
      let row = [...rows.values()].find(row => row.code_hash === input.codeHash);
      if (row) {
        if (row.user_id !== scope.userId || row.company_id !== scope.companyId) throw new utils.WabaOnboardingError('SIGNUP_AUTHORIZATION_USED', 'Authorization used', false, 403);
        if (input.wabaId && row.requested_waba_id && row.requested_waba_id !== input.wabaId) throw new utils.WabaOnboardingError('SIGNUP_IDEMPOTENCY_CONFLICT', 'Different selection', false, 409);
        return { row: structuredClone(row), created: false };
      }
      row = { id: crypto.randomUUID(), user_id: scope.userId, company_id: scope.companyId, code_hash: input.codeHash,
        requested_waba_id: input.wabaId, requested_phone_id: input.phoneId, status: 'exchanging_code', step: 'code_exchange',
        progress: { setup_mode: input.mode }, authorized_wabas: [], attempts: 0, max_attempts: 6 };
      rows.set(row.id, row); calls.push('reserved'); return { row: structuredClone(row), created: true };
    },
    async saveToken(id, encrypted, expiresIn) {
      calls.push('token_persisted');
      if (options.saveFailure) throw Error('database unavailable');
      const row = rows.get(id); Object.assign(row, { token_encrypted: encrypted, token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        status: 'pending', step: 'resolve_assets', next_attempt_at: new Date() }); return structuredClone(row);
    },
    async exchangeFailed(id, error) { Object.assign(rows.get(id), { status: 'failed', error_code: error.code, error_message: error.message, retryable: false }); },
    async find(scope, id) { const row = rows.get(id); return row?.user_id === scope.userId && row.company_id === scope.companyId ? structuredClone(row) : null; },
    async select(scope, id, wabaId, phoneId) {
      const row = await this.find(scope, id); if (!row) throw new utils.WabaOnboardingError('WABA_ONBOARDING_NOT_FOUND', 'Not found', false, 404);
      if (wabaId) row.requested_waba_id = wabaId; if (phoneId) row.requested_phone_id = phoneId;
      rows.set(id, row); return row;
    },
    async retry(scope, id) { const row = await this.find(scope, id); Object.assign(row, { status: 'pending', attempts: 0 }); rows.set(id, row); return structuredClone(row); },
    async claim() {
      const row = [...rows.values()].find(row => row.status === 'pending' || row.status === 'processing' && options.expireLease);
      if (!row) return null;
      Object.assign(row, { status: 'processing', lease_token: crypto.randomUUID(), attempts: row.attempts + 1 }); return structuredClone(row);
    },
    async checkpoint(claimed, changes) {
      const row = rows.get(claimed.id);
      if (row.lease_token !== claimed.lease_token || row.status !== 'processing') throw new utils.WabaOnboardingError('SIGNUP_LEASE_LOST', 'Lease lost', true, 409);
      for (const [key, value] of Object.entries(changes)) row[key] = ['progress', 'authorized_wabas'].includes(key) && typeof value === 'string' ? JSON.parse(value) : value;
      return structuredClone(row);
    },
    finish: model.default.finish,
    async claimAccount(row, details) {
      calls.push('claim_account');
      if (options.foreignAccount) throw new utils.WabaOnboardingError('WABA_ALREADY_CONNECTED_ELSEWHERE', 'Already connected elsewhere', false, 409);
      return { id: '00000000-0000-4000-8000-000000000003', waba_id: details.id };
    },
    async connected(row) { calls.push('connected'); Object.assign(rows.get(row.id), { status: 'connected', error_code: null, error_message: null, retryable: false }); },
    async phones(row) { return row.waba_record_id ? (inventories[row.resolved_waba_id] || []).map(phone => ({ ...phone, id: 'local-' + phone.id, meta_data: phone, connection_status: phone.status === 'CONNECTED' ? 'connected' : 'pending' })) : []; },
    async accountEvents(events) { calls.push(['account_events', events]); },
  };
  let partialFailure = options.partialFailure;
  const factory = (authorizedToken, heartbeat) => ({
    async inspect() { calls.push('inspect'); if (authorizedToken !== token) throw Error('Must resume saved customer token'); await heartbeat();
      return { ids: options.authorized || Object.keys(inventories), scopes: new Set(options.scopes || ['whatsapp_business_management', 'whatsapp_business_messaging']) };
    },
    async getWabaDetails(id) { await heartbeat(); return { id, name: 'Test business' }; },
    async getPhoneNumbers(id) { await heartbeat(); return { data: structuredClone(inventories[id] || []) }; },
    async verifyAppWebhooks(coexist) { calls.push(['verify_app', coexist]); await heartbeat(); if (options.webhookConfigurationFailure) throw options.webhookConfigurationFailure; },
    async subscribe() { counts.subscribes++; calls.push('subscribe'); await heartbeat(); if (partialFailure) { partialFailure = false; throw new utils.WabaOnboardingError('META_TEMPORARILY_UNAVAILABLE', 'Meta unavailable', true, 503); } },
    async phone(id) { await heartbeat(); return structuredClone(Object.values(inventories).flat().find(phone => phone.id === id)); },
    async register(id) { counts.registers++; calls.push('register'); await heartbeat();
      if (options.registrationTimeout) throw new utils.WabaOnboardingError('META_TEMPORARILY_UNAVAILABLE', 'Registration unconfirmed', true, 503);
      Object.values(inventories).flat().find(phone => phone.id === id).status = 'CONNECTED';
    },
  });
  const sync = async (userId, companyId, id, graph) => { counts.syncs++; calls.push('sync');
    if (userId !== owner.userId || companyId !== owner.companyId || !graph) throw Error('Sync must use authenticated owner and saved token');
    const selected = [...rows.values()].find(row => row.waba_record_id === id)?.resolved_waba_id;
    return { phone_numbers: (inventories[selected] || []).map(phone => ({ phone_number_id: phone.id, meta_data: structuredClone(phone) })) };
  };
  const exports = loadSource('src/app/services/wabaOnboarding.service.ts', {
    crypto, uuid: require('uuid'), '@surefy/exceptions/HTTP400Error': BadRequest, '../models/wabaOnboarding.model': repo,
    './wabaGraph.service': { WabaGraph: class {} }, './waba.service': { syncWaba: sync }, '../utils/wabaOnboarding': utils,
  }, { Date });
  const createService = () => new exports.WabaOnboardingService(repo, factory, sync);
  const service = createService();
  return { service, createService, repo, rows, counts, calls, inventories,
    // Seed a previously saved token-backed job; new requests use WabaService directly.
    begin: async (body = {}) => {
      const { row } = await repo.reserve(owner, { codeHash: utils.digest(crypto.randomUUID()),
        wabaId: body.waba_id ?? null, phoneId: body.phone_number_id ?? null, mode: body.setup_mode ?? 'auto' });
      await repo.saveToken(row.id, utils.sealToken(token, owner, row.id), 3600);
      return service.status(owner, row.id);
    },
    run: async (worker = service) => { const row = await repo.claim(); if (row) await worker.process(row); },
    current: () => structuredClone([...rows.values()][0]), utils };
}
module.exports = { fixture, utils, env, owner, code, token, connectedPhone, loadSource };
