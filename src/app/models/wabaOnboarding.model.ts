import db from '@surefy/database';
import crypto from 'crypto';
import { WabaScope, WabaOnboardingError, digest } from '../utils/wabaOnboarding';

const scoped = (scope: WabaScope) => ({ user_id: scope.userId, company_id: scope.companyId });
const conflict = () => new WabaOnboardingError('SIGNUP_IDEMPOTENCY_CONFLICT', 'This onboarding already has a different authorization or account selection. Use its saved status or start a new signup.', false, 409);

class WabaOnboardingModel {
  async createState(scope: WabaScope) {
    const state = crypto.randomBytes(32).toString('hex');
    await db('waba_onboarding_states').insert({ ...scoped(scope), state_hash: digest(state), expires_at: new Date(Date.now() + 10 * 60000) });
    return state;
  }
  async reserve(scope: WabaScope, input: { codeHash: string; wabaId: string | null; phoneId: string | null; state: string | null; key: string | null; mode: string }) {
    return db.transaction(async trx => {
      let state: any;
      if (input.state) {
        state = await trx('waba_onboarding_states').where({ state_hash: digest(input.state), ...scoped(scope) }).forUpdate().first();
        if (!state || !state.onboarding_id && new Date(state.expires_at) <= new Date()) throw new WabaOnboardingError('SIGNUP_STATE_INVALID', 'Signup state is invalid or expired. Start a new signup.', false, 403);
      }
      const [inserted] = await trx('waba_onboardings').insert({ ...scoped(scope), code_hash: input.codeHash,
        idempotency_key: input.key, requested_waba_id: input.wabaId, requested_phone_id: input.phoneId,
        progress: JSON.stringify({ setup_mode: input.mode }) }).onConflict().ignore().returning('*');
      let row = inserted || await trx('waba_onboardings').where({ code_hash: input.codeHash }).forUpdate().first();
      if (!row && input.key) row = await trx('waba_onboardings').where({ ...scoped(scope), idempotency_key: input.key }).forUpdate().first();
      if (!row || row.user_id !== scope.userId || row.company_id !== scope.companyId) throw new WabaOnboardingError(
        'SIGNUP_AUTHORIZATION_USED', 'This authorization cannot be used for this account. Complete Embedded Signup again.', false, 403);
      if (row.code_hash !== input.codeHash || input.key && row.idempotency_key !== input.key ||
          input.mode !== (row.progress?.setup_mode || 'auto') || state?.onboarding_id && state.onboarding_id !== row.id) throw conflict();
      if (state && !state.onboarding_id) await trx('waba_onboarding_states').where({ state_hash: state.state_hash }).update({ onboarding_id: row.id });
      if (!inserted) row = await this.select(scope, row.id, input.wabaId, input.phoneId, trx);
      return { row, created: Boolean(inserted) };
    });
  }
  async find(scope: WabaScope, id: string) {
    return db('waba_onboardings').where({ id, ...scoped(scope) }).first();
  }
  async select(scope: WabaScope, id: string, wabaId: string | null, phoneId: string | null, connection: any = db): Promise<any> {
    if (connection === db) return db.transaction(trx => this.select(scope, id, wabaId, phoneId, trx));
    const row = await connection('waba_onboardings').where({ id, ...scoped(scope) }).forUpdate().first();
    if (!row) throw new WabaOnboardingError('WABA_ONBOARDING_NOT_FOUND', 'Onboarding not found in your account.', false, 404);
    const correctable = !row.waba_record_id && ['action_required', 'needs_selection'].includes(row.status);
    const authorizedCorrection = correctable && (row.authorized_wabas || []).some((account: any) => account.id === wabaId);
    if (wabaId && (row.requested_waba_id && row.requested_waba_id !== wabaId && !authorizedCorrection ||
        row.resolved_waba_id && row.resolved_waba_id !== wabaId) ||
        phoneId && row.requested_phone_id && row.requested_phone_id !== phoneId && !correctable) throw conflict();
    const changed = wabaId && row.requested_waba_id !== wabaId || phoneId && row.requested_phone_id !== phoneId;
    if (!changed) return row;
    if (row.status === 'connected') throw conflict();
    const [updated] = await connection('waba_onboardings').where({ id, ...scoped(scope) }).update({
      ...(wabaId ? { requested_waba_id: wabaId } : {}), ...(phoneId ? { requested_phone_id: phoneId } : {}),
      ...(row.token_encrypted ? { status: 'pending', lease_token: null, lease_expires_at: null, next_attempt_at: new Date() } : {}),
      ...(['action_required', 'needs_selection'].includes(row.status) ? { attempts: 0, error_code: null, error_message: null, retryable: false } : {}),
      updated_at: new Date(),
    }).returning('*');
    return updated;
  }
  async saveToken(id: string, encrypted: string, expiresIn: number | null) {
    const [row] = await db('waba_onboardings').where({ id, status: 'exchanging_code' }).update({ token_encrypted: encrypted,
      token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      status: 'pending', step: 'resolve_assets', next_attempt_at: new Date(), updated_at: new Date() }).returning('*');
    if (!row) throw conflict();
    return row;
  }
  async exchangeFailed(id: string, error: WabaOnboardingError) {
    await db('waba_onboardings').where({ id, status: 'exchanging_code' }).update({
      status: error.code === 'CODE_EXCHANGE_UNCONFIRMED' ? 'exchange_uncertain' : 'failed',
      error_code: error.code, error_message: error.message, retryable: false, updated_at: new Date(),
    });
  }
  async claim() {
    return db.transaction(async trx => {
      await trx('waba_onboardings').where({ status: 'exchanging_code' }).where('created_at', '<', new Date(Date.now() - 120000))
        .update({ status: 'exchange_uncertain', error_code: 'CODE_EXCHANGE_UNCONFIRMED', retryable: false,
          error_message: 'The exchange was interrupted. Complete Embedded Signup again; the old code will not be replayed.', updated_at: new Date() });
      const row = await trx('waba_onboardings').whereNotNull('token_encrypted').andWhere(query => query
        .where(inner => inner.where({ status: 'pending' }).where('next_attempt_at', '<=', new Date()))
        .orWhere(inner => inner.where({ status: 'processing' }).where('lease_expires_at', '<', new Date())))
        .orderBy('next_attempt_at').forUpdate().skipLocked().first();
      if (!row) return null;
      const [claimed] = await trx('waba_onboardings').where({ id: row.id }).update({ status: 'processing',
        lease_token: crypto.randomUUID(), lease_expires_at: new Date(Date.now() + 120000), attempts: row.attempts + 1,
        updated_at: new Date() }).returning('*');
      return claimed;
    });
  }
  async checkpoint(row: any, changes: Record<string, any>) {
    const [updated] = await db('waba_onboardings').where({ id: row.id, user_id: row.user_id, company_id: row.company_id,
      lease_token: row.lease_token, status: 'processing' })
      .update({ lease_expires_at: new Date(Date.now() + 120000), updated_at: new Date(), ...changes }).returning('*');
    if (!updated) throw new WabaOnboardingError('SIGNUP_LEASE_LOST', 'Onboarding work moved to another worker.', true, 409);
    return updated;
  }
  async retry(scope: WabaScope, id: string) {
    const row = await this.find(scope, id);
    if (!row) throw new WabaOnboardingError('WABA_ONBOARDING_NOT_FOUND', 'Onboarding not found in your account.', false, 404);
    if (['pending', 'processing', 'connected'].includes(row.status)) return row;
    if (!row.token_encrypted) throw new WabaOnboardingError('META_CODE_INVALID', 'There is no saved authorization. Complete Embedded Signup again.', false, 409);
    if (row.token_expires_at && new Date(row.token_expires_at) <= new Date()) throw new WabaOnboardingError('SIGNUP_TOKEN_INVALID', 'The saved authorization expired. Complete Embedded Signup again.', false, 403);
    const [updated] = await db('waba_onboardings').where({ id, ...scoped(scope), status: row.status }).update({ status: 'pending',
      attempts: 0, next_attempt_at: new Date(), lease_token: null, lease_expires_at: null, error_code: null, error_message: null,
      retryable: false, updated_at: new Date() }).returning('*');
    return updated || await this.find(scope, id);
  }
  async finish(row: any, error: WabaOnboardingError, status?: string) {
    const retry = error.retryable && row.attempts < row.max_attempts;
    const exhausted = error.retryable && !retry;
    return this.checkpoint(row, { status: status || (retry ? 'pending' : 'action_required'),
      error_code: exhausted ? 'SIGNUP_RETRY_EXHAUSTED' : error.code,
      error_message: exhausted ? 'Automatic setup retries were exhausted. Fix the reported setup issue and retry this saved onboarding.' : error.message,
      retryable: error.retryable, next_attempt_at: retry ? new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(row.attempts - 1, 6))) : null,
      lease_token: null, lease_expires_at: null });
  }
  async claimAccount(row: any, details: any) {
    return db.transaction(async trx => {
      await trx('users').where({ id: row.user_id }).forUpdate().first();
      const attempt = await trx('waba_onboardings').where({ id: row.id, user_id: row.user_id, company_id: row.company_id,
        lease_token: row.lease_token, status: 'processing' }).forUpdate().first();
      if (!attempt) throw new WabaOnboardingError('SIGNUP_LEASE_LOST', 'Onboarding lease was replaced.', true, 409);
      const [inserted] = await trx('waba_accounts').insert({ user_id: row.user_id, company_id: row.company_id,
        waba_id: details.id, name: details.name, currency: details.currency, status: 'inactive', connection_status: 'pending',
        current_onboarding_id: row.id, onboarding_started_at: row.created_at }).onConflict('waba_id').ignore().returning('*');
      const account = inserted || await trx('waba_accounts').where({ waba_id: details.id }).forUpdate().first();
      if (account.user_id != null && account.user_id !== row.user_id || account.company_id !== row.company_id) throw new WabaOnboardingError(
        'WABA_ALREADY_CONNECTED_ELSEWHERE', 'This WhatsApp account is already associated with another account. Contact your platform administrator.', false, 409);
      if (account.user_id == null) {
        const conflict = await trx('phone_numbers').where({ waba_id: account.id }).andWhere(query => query
          .whereNot('company_id', row.company_id).orWhere(inner => inner.whereNotNull('user_id').whereNot('user_id', row.user_id))).first();
        if (conflict) throw new WabaOnboardingError('WABA_ALREADY_CONNECTED_ELSEWHERE', 'This legacy account contains phone ownership conflicts. Contact your platform administrator.', false, 409);
        await trx('phone_numbers').where({ waba_id: account.id, company_id: row.company_id }).whereNull('user_id')
          .update({ user_id: row.user_id, connection_status: 'pending', updated_at: new Date() });
      }
      if (account.onboarding_started_at && new Date(account.onboarding_started_at) > new Date(row.created_at)) {
        throw new WabaOnboardingError('WABA_SIGNUP_SUPERSEDED', 'A newer signup is already configuring this account. Use its onboarding status.', false, 409);
      }
      const [updated] = await trx('waba_accounts').where({ id: account.id, company_id: row.company_id }).update({ user_id: row.user_id,
        current_onboarding_id: row.id, onboarding_started_at: row.created_at, deleted_at: null,
        ...(account.deleted_at || account.user_id == null ? { status: 'inactive', connection_status: 'pending' } : {}), updated_at: new Date(),
      }).returning('*');
      return updated;
    });
  }
  async connected(row: any) {
    return db.transaction(async trx => {
      await trx('users').where({ id: row.user_id }).forUpdate().first();
      const attempt = await trx('waba_onboardings').where({ id: row.id, user_id: row.user_id, company_id: row.company_id,
        lease_token: row.lease_token, status: 'processing' }).forUpdate().first();
      const account = await trx('waba_accounts').where({ id: row.waba_record_id, user_id: row.user_id, company_id: row.company_id,
        current_onboarding_id: row.id }).whereNull('deleted_at').forUpdate().first();
      if (!attempt || !account) throw new WabaOnboardingError('WABA_SIGNUP_SUPERSEDED', 'A newer onboarding replaced this setup. Check its status.', false, 409);
      if (!attempt.progress?.webhooks_confirmed || !attempt.progress?.phone_setup_confirmed || attempt.step !== 'confirm_inventory') {
        throw new WabaOnboardingError('WABA_SETUP_REQUIRED', 'Webhook and phone setup must be confirmed before connecting this account.', false, 409);
      }
      const [credential] = await trx('waba_credentials').insert({ waba_record_id: account.id, user_id: row.user_id, company_id: row.company_id,
        onboarding_id: row.id, token_encrypted: row.token_encrypted, expires_at: row.token_expires_at }).onConflict('waba_record_id')
        .merge(['onboarding_id', 'token_encrypted', 'expires_at']).where({ 'waba_credentials.user_id': row.user_id,
          'waba_credentials.company_id': row.company_id }).returning('waba_record_id');
      if (!credential) throw new WabaOnboardingError('WABA_ALREADY_CONNECTED_ELSEWHERE', 'Account credential ownership changed. Contact your platform administrator.', false, 409);
      const now = new Date();
      await trx('waba_accounts').where({ id: account.id }).update({ status: 'active', connection_status: 'connected', connected_at: now, updated_at: now });
      await trx('phone_numbers').where({ waba_id: account.id, user_id: row.user_id, company_id: row.company_id })
        .whereNull('deleted_at').whereRaw("meta_data->>'status' = 'CONNECTED' AND meta_data->>'platform_type' = 'CLOUD_API'")
        .update({ connection_status: 'connected', updated_at: now });
      const [done] = await trx('waba_onboardings').where({ id: row.id, lease_token: row.lease_token }).update({ status: 'connected', step: 'complete',
        connected_at: now, lease_token: null, lease_expires_at: null, next_attempt_at: null, error_code: null, error_message: null,
        retryable: false, updated_at: now }).returning('*');
      return done;
    });
  }
  async phones(row: any) {
    if (!row.waba_record_id) return [];
    return db('phone_numbers').where({ waba_id: row.waba_record_id, user_id: row.user_id, company_id: row.company_id }).whereNull('deleted_at').orderBy('created_at');
  }
  async accountEvents(events: Array<{ hash: string; wabaId: string; event: string; at: Date | null }>) {
    return db.transaction(async trx => {
      for (const event of events) {
        const [inserted] = await trx('waba_account_events').insert({ event_hash: event.hash, waba_id: event.wabaId,
          event: event.event, event_at: event.at }).onConflict('event_hash').ignore().returning('event_hash');
        if (!inserted) continue;
        // An event can only wake an already-associated attempt; it never assigns a tenant or a token.
        await trx('waba_onboardings').whereNotNull('token_encrypted').whereIn('status', ['pending', 'action_required', 'needs_selection'])
          .andWhere(query => query.where('resolved_waba_id', event.wabaId).orWhere('requested_waba_id', event.wabaId)
            .orWhereRaw('authorized_wabas @> ?::jsonb', [JSON.stringify([{ id: event.wabaId }])]))
          .whereIn('error_code', ['SIGNUP_NO_AUTHORIZED_WABA', 'WABA_REGISTRATION_PENDING', 'WABA_COEXISTENCE_PENDING',
            'WABA_WEBHOOK_SUBSCRIPTION_PENDING', 'SIGNUP_RETRY_EXHAUSTED', 'META_TEMPORARILY_UNAVAILABLE'])
          .update({ status: 'pending', attempts: 0, next_attempt_at: new Date(), updated_at: new Date() });
      }
    });
  }
}
export default new WabaOnboardingModel();
