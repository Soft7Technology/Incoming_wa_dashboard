import crypto from 'crypto';
import { validate as uuid } from 'uuid';
import repository from '../models/wabaOnboarding.model';
import { WabaGraph } from './wabaGraph.service';
import wabaService from './waba.service';
import { digest, metaId, openToken, sealToken, safeOnboardingError, wabaConfig, WabaScope, WabaOnboardingError } from '../utils/wabaOnboarding';

const publicPhones = (phones: any[]) => phones.map(phone => ({ id: phone.id, phone_number_id: phone.phone_number_id,
  display_phone_number: phone.display_phone_number, verified_name: phone.verified_name, quality_rating: phone.quality_rating,
  code_verification_status: phone.code_verification_status, active: phone.active, inactive_reason: phone.inactive_reason,
  connection_status: phone.connection_status, meta_status: phone.meta_data?.status,
  platform_type: phone.meta_data?.platform_type, is_on_biz_app: phone.meta_data?.is_on_biz_app,
  created_at: phone.created_at, updated_at: phone.updated_at }));

export class WabaOnboardingService {
  constructor(private readonly repo = repository, private readonly graphFactory = (token?: string, heartbeat?: () => Promise<void>) => new WabaGraph(token, heartbeat),
    private readonly sync = wabaService.syncWaba.bind(wabaService)) {}
  private scope(scope: WabaScope) {
    if (!scope.userId || !scope.companyId) throw new WabaOnboardingError('WABA_ACCOUNT_CONTEXT_REQUIRED', 'Authenticated user and company context are required.', false, 403);
  }
  async begin(scope: WabaScope, body: any, key?: string) {
    this.scope(scope);
    const wabaId = metaId(body?.waba_id, 'waba_id'), phoneId = metaId(body?.phone_number_id, 'phone_number_id');
    if (typeof body?.code !== 'string' || !body.code.trim() || body.code.length > 8192) throw new WabaOnboardingError('META_CODE_INVALID', 'Submit the authorization code immediately after Embedded Signup. Existing connections can use the sync endpoint.');
    if (body.state != null && (typeof body.state !== 'string' || !/^[a-f0-9]{64}$/.test(body.state))) throw new WabaOnboardingError('SIGNUP_STATE_INVALID', 'Use the state issued by the onboarding state endpoint, or null for the existing frontend.', false, 403);
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 100)) throw new WabaOnboardingError('INVALID_SIGNUP_INPUT', 'Idempotency-Key must contain 1 to 100 characters.');
    const mode = body.setup_mode ?? 'auto';
    if (!['auto', 'waba_only'].includes(mode) || mode === 'waba_only' && phoneId) throw new WabaOnboardingError('INVALID_SIGNUP_INPUT', 'setup_mode must be auto or waba_only; WABA-only setup cannot select a phone.');
    // Configuration/encryption validation is local; exchange follows only one short reservation transaction.
    wabaConfig();
    const reserved = await this.repo.reserve(scope, { codeHash: digest(body.code), wabaId, phoneId, state: body.state ?? null, key: key || null, mode });
    if (!reserved.created) return this.result(reserved.row);
    let row = reserved.row;
    let exchangedSuccessfully = false;
    try {
      const exchanged = await this.graphFactory().exchange(body.code);
      exchangedSuccessfully = true;
      // No discovery, registration, subscription, queue call or other network work before this commit.
      row = await this.repo.saveToken(row.id, sealToken(exchanged.token, scope, row.id), exchanged.expiresIn);
    } catch (error) {
      const safe = exchangedSuccessfully ? new WabaOnboardingError('WABA_AUTHORIZATION_SAVE_UNCONFIRMED',
        'Meta exchanged the code, but saving the authorization was not confirmed. Check this onboarding status; if no authorization was saved, complete Embedded Signup again.', false, 503) : safeOnboardingError(error);
      await this.repo.exchangeFailed(row.id, safe).catch(() => undefined);
      throw new WabaOnboardingError(safe.code, safe.message, false, safe.statusCode);
    }
    return this.result(row);
  }
  async state(scope: WabaScope) { this.scope(scope); return { state: await this.repo.createState(scope), expires_in_seconds: 600 }; }
  async status(scope: WabaScope, id: string) {
    this.scope(scope);
    if (!uuid(id)) throw new WabaOnboardingError('INVALID_SIGNUP_INPUT', 'onboardingId must be a UUID.');
    const row = await this.repo.find(scope, id);
    if (!row) throw new WabaOnboardingError('WABA_ONBOARDING_NOT_FOUND', 'Onboarding not found in your account.', false, 404);
    return this.result(row);
  }
  async retry(scope: WabaScope, id: string, body: any) {
    this.scope(scope);
    if (!uuid(id)) throw new WabaOnboardingError('INVALID_SIGNUP_INPUT', 'onboardingId must be a UUID.');
    await this.repo.select(scope, id, metaId(body?.waba_id, 'waba_id'), metaId(body?.phone_number_id, 'phone_number_id'));
    return this.result(await this.repo.retry(scope, id));
  }
  private async result(row: any) {
    const error = row.error_code ? { code: row.error_code, retryable: row.retryable, message: row.error_message } : undefined;
    if (row.status === 'connected') return { httpStatus: 200, connected: true,
      data: { id: row.waba_record_id, waba_id: row.resolved_waba_id, status: 'connected', phone_numbers: publicPhones(await this.repo.phones(row)) } };
    const pending = ['exchanging_code', 'pending', 'processing'].includes(row.status);
    return { httpStatus: pending || row.status === 'needs_selection' ? 202 : 409, connected: false,
      data: { onboarding_id: row.id, status: pending ? 'pending' : row.status, stage: row.step,
        waba_id: row.resolved_waba_id || row.requested_waba_id || null,
        authorized_wabas: row.authorized_wabas || [], phone_numbers: publicPhones(await this.repo.phones(row)),
        status_url: `/v1/admin/waba/onboard/${row.id}`, poll_after_ms: pending ? 2000 : null,
        ...(error ? { error } : {}) } };
  }
  async process(row: any) {
    const scope = { userId: row.user_id, companyId: row.company_id };
    const heartbeat = async () => { row = await this.repo.checkpoint(row, {}); };
    const save = async (changes: Record<string, any>) => { row = await this.repo.checkpoint(row, changes); };
    try {
      if (row.attempts > row.max_attempts) throw new WabaOnboardingError('SIGNUP_RETRY_EXHAUSTED', 'The worker restart/retry limit was reached. Retry the saved onboarding after checking setup.', false, 409);
      const token = openToken(row.token_encrypted, scope, row.id);
      const graph = this.graphFactory(token, heartbeat);
      const grants = await graph.inspect();
      const authorized = grants.ids.map(id => ({ id }));
      await save({ authorized_wabas: JSON.stringify(authorized), step: 'resolve_assets' });
      if (!grants.ids.length) throw new WabaOnboardingError('SIGNUP_NO_AUTHORIZED_WABA', 'No authorized WABA is visible yet. Complete account sharing in Meta; setup will retry with the saved token.', true, 409);
      let selected = row.requested_waba_id || row.resolved_waba_id;
      if (selected && !grants.ids.includes(selected)) throw new WabaOnboardingError('WABA_NOT_AUTHORIZED', 'The signup token does not authorize the selected WABA. Select an authorized account or reconnect.', false, 403);
      if (!selected && row.requested_phone_id) {
        const matches: string[] = [];
        for (const id of grants.ids) if ((await graph.getPhoneNumbers(id)).data.some(phone => phone.id === row.requested_phone_id)) matches.push(id);
        if (matches.length === 1) selected = matches[0];
        else throw new WabaOnboardingError('SIGNUP_PHONE_NOT_IN_WABA', 'The selected phone is not uniquely available in the authorized WABAs.', false, 403);
      }
      if (!selected && grants.ids.length === 1) selected = grants.ids[0];
      if (!selected) {
        await this.repo.finish(row, new WabaOnboardingError('SIGNUP_SELECTION_REQUIRED', 'Select the WABA to connect. Multiple accounts were authorized.'), 'needs_selection');
        return;
      }
      const details = await graph.getWabaDetails(selected);
      if (!details || details.id !== selected) throw new WabaOnboardingError('WABA_META_RESPONSE_INVALID', 'Meta returned a different account. Reconnect through Embedded Signup.', false, 403);
      const inventory = await graph.getPhoneNumbers(selected);
      if (row.requested_phone_id && !inventory.data.some(phone => phone.id === row.requested_phone_id)) throw new WabaOnboardingError('SIGNUP_PHONE_NOT_IN_WABA', 'The selected phone number does not belong to the selected WABA.', false, 403);
      const account = await this.repo.claimAccount(row, details);
      await save({ resolved_waba_id: selected, waba_record_id: account.id, step: 'sync_inventory' });
      await this.sync(scope.userId, scope.companyId, account.id, graph);
      const coexist = inventory.data.some(phone => phone.is_on_biz_app === true);
      await save({ step: 'webhook_subscription' });
      await graph.verifyAppWebhooks(coexist);
      await graph.subscribe(selected);
      await save({ step: 'phone_setup', progress: JSON.stringify({ ...row.progress, webhooks_confirmed: true }) });
      const wabaOnly = row.progress?.setup_mode === 'waba_only' || !inventory.data.length ||
        !row.requested_phone_id && !grants.scopes.has('whatsapp_business_messaging');
      if (!wabaOnly && !grants.scopes.has('whatsapp_business_messaging')) throw new WabaOnboardingError('META_PERMISSION_REQUIRED', 'Grant whatsapp_business_messaging in the signup configuration and reconnect before registering/using the selected number.', false, 403);
      const pending = inventory.data.filter(phone => phone.status !== 'CONNECTED');
      if (!wabaOnly && !row.requested_phone_id && inventory.data.length > 1 && pending.length) {
        await this.repo.finish(row, new WabaOnboardingError('WABA_PHONE_SELECTION_REQUIRED', 'Select which phone number to finish configuring from this WABA.'), 'needs_selection');
        return;
      }
      const target = row.requested_phone_id ? inventory.data.find(phone => phone.id === row.requested_phone_id) : inventory.data.length === 1 ? inventory.data[0] : null;
      if (!wabaOnly && target) {
        let phone = await graph.phone(target.id);
        if (typeof phone.is_on_biz_app !== 'boolean' || phone.platform_type === 'ON_PREMISE') throw new WabaOnboardingError(
          'WABA_PHONE_MODE_UNCONFIRMED', 'Confirm this phone is connected through Cloud API or Coexistence in WhatsApp Manager. This endpoint does not migrate On-Premises numbers.', false, 409);
        if (phone.is_on_biz_app === true) {
          // Coexistence is confirmed by Meta, never by a browser hint. Do not migrate/deregister/register it as Cloud-only.
          if (phone.status !== 'CONNECTED' || phone.platform_type !== 'CLOUD_API') throw new WabaOnboardingError('WABA_COEXISTENCE_PENDING', 'Meta has not confirmed the Coexistence connection yet. Setup will recheck; keep WhatsApp Business connected.', true, 409);
        } else if (phone.status !== 'CONNECTED') {
          if (phone.code_verification_status !== 'VERIFIED') throw new WabaOnboardingError('WABA_PHONE_VERIFICATION_REQUIRED', 'Complete phone verification in Meta before registering this Cloud API number.', false, 409);
          const registrations = { ...row.progress?.registrations }, previous = registrations[target.id];
          if (previous?.uncertain || previous?.accepted) throw new WabaOnboardingError('WABA_REGISTRATION_PENDING', 'Registration was dispatched but not confirmed. Setup will recheck Meta without blindly repeating registration.', true, 409);
          if (phone.is_on_biz_app !== false || phone.platform_type === 'ON_PREMISE') throw new WabaOnboardingError('WABA_PHONE_MODE_UNCONFIRMED', 'Meta has not confirmed this is a standard Cloud API number. Check its onboarding/migration mode in WhatsApp Manager.', false, 409);
          const pin = previous?.pin_encrypted ? openToken(previous.pin_encrypted, scope, `${row.id}:pin:${target.id}`) : String(crypto.randomInt(0, 1000000)).padStart(6, '0');
          registrations[target.id] = { pin_encrypted: sealToken(pin, scope, `${row.id}:pin:${target.id}`), uncertain: true };
          await save({ progress: JSON.stringify({ ...row.progress, registrations }) });
          try { await graph.register(target.id, pin); }
          catch (error: any) {
            // A definite rejection can be corrected and retried; an uncertain dispatch cannot.
            if (error?.retryable === false) {
              registrations[target.id].uncertain = false;
              await save({ progress: JSON.stringify({ ...row.progress, registrations }) });
            }
            throw error;
          }
          registrations[target.id].uncertain = false;
          registrations[target.id].accepted = true;
          await save({ progress: JSON.stringify({ ...row.progress, registrations }) });
          phone = await graph.phone(target.id);
          if (phone.status !== 'CONNECTED') throw new WabaOnboardingError('WABA_REGISTRATION_PENDING', 'Meta accepted registration but has not reported CONNECTED yet. Setup will recheck.', true, 409);
        }
      }
      await save({ step: 'confirm_inventory', progress: JSON.stringify({ ...row.progress, phone_setup_confirmed: true }) });
      const refreshed = await this.sync(scope.userId, scope.companyId, account.id, graph);
      if (!wabaOnly && target && !refreshed.phone_numbers.some((phone: any) => phone.phone_number_id === target.id &&
        phone.meta_data?.status === 'CONNECTED' && phone.meta_data?.platform_type === 'CLOUD_API')) throw new WabaOnboardingError(
          'WABA_REGISTRATION_PENDING', 'The final phone inventory has not confirmed the selected connection yet. Setup will recheck.', true, 409);
      await this.repo.connected(row);
    } catch (error: any) {
      if (error?.code === 'SIGNUP_LEASE_LOST') return;
      const safe = safeOnboardingError(error);
      await this.repo.finish(row, safe, safe.code === 'WABA_PHONE_SELECTION_REQUIRED' ? 'needs_selection' : undefined);
    }
  }
  async receiveAccountUpdates(payload: any) {
    if (payload?.object !== 'whatsapp_business_account') return;
    const events: Array<{ hash: string; wabaId: string; event: string; at: Date | null }> = [];
    for (const entry of Array.isArray(payload.entry) ? payload.entry : []) for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (change.field !== 'account_update' || !/^\d+$/.test(String(entry.id)) ||
          typeof change.value?.event !== 'string' || !/^[A-Z_]{1,80}$/.test(change.value.event)) continue;
      const wabaId = String(change.value?.waba_info?.waba_id || entry.id);
      if (wabaId !== String(entry.id)) continue;
      const date = new Date(Number(entry.time) * 1000);
      const at = Number(entry.time) > 0 && Number.isFinite(date.getTime()) ? date : null;
      events.push({ hash: digest(JSON.stringify([wabaId, change.value.event, entry.time ?? null, change.value])),
        wabaId, event: change.value.event.slice(0, 80), at });
    }
    if (events.length) await this.repo.accountEvents(events);
  }
}
export default new WabaOnboardingService();
