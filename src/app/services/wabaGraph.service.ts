import axios from 'axios';
import crypto from 'crypto';
import { WabaOnboardingError, wabaConfig } from '../utils/wabaOnboarding';

/** Dedicated transport: never log/throw an Axios object containing credentials. */
export class WabaGraph {
  constructor(private readonly token?: string, private readonly heartbeat?: () => Promise<void>) {}
  async call(path: string, method = 'GET', params: Record<string, any> = {}, data?: any): Promise<any> {
    const config = wabaConfig();
    await this.heartbeat?.();
    try {
      const response = await axios.request({ url: `https://graph.facebook.com/${config.version}/${path}`,
        method, params: { ...params, ...(this.token ? {
          appsecret_proof: crypto.createHmac('sha256', config.appSecret).update(this.token).digest('hex'),
        } : {}) }, data, headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        timeout: 15000, maxRedirects: 0, maxContentLength: 5 * 1024 * 1024 });
      if (response.data?.error) throw { response: { status: 400, data: response.data } };
      return response.data;
    } catch (error: any) {
      const code = Number(error.response?.data?.error?.code);
      if (code === 190) throw new WabaOnboardingError('SIGNUP_TOKEN_INVALID', 'WhatsApp authorization expired or was revoked. Complete Embedded Signup again.', false, 403);
      if ([10, 200, 294].includes(code)) throw new WabaOnboardingError('META_PERMISSION_REQUIRED',
        'Meta denied access. Check WhatsApp business management/messaging permissions, asset assignments, and app access approval, then reconnect.', false, 403);
      if (!error.response || error.response.status >= 500 || error.response.status === 429 || [1, 2, 4, 17, 32, 341, 613].includes(code)) {
        throw new WabaOnboardingError('META_TEMPORARILY_UNAVAILABLE', 'Meta is temporarily unavailable. Setup will retry using the saved authorization.', true, 503);
      }
      throw new WabaOnboardingError('WABA_META_SETUP_REJECTED',
        'Meta rejected this setup step. Check the selected asset, app configuration, number verification and WhatsApp Manager, then retry the saved onboarding.', false, 409);
    }
  }
  async inspect() {
    const { appId, appSecret } = wabaConfig();
    const result = await new WabaGraph(`${appId}|${appSecret}`, this.heartbeat).call('debug_token', 'GET', { input_token: this.token });
    const info = result.data;
    if (!info?.is_valid || String(info.app_id) !== appId ||
      [info.expires_at, info.data_access_expires_at].some(value => Number(value) > 0 && Number(value) * 1000 <= Date.now())) {
      throw new WabaOnboardingError('SIGNUP_TOKEN_INVALID', 'The authorization is invalid, expired, or belongs to another Meta app. Reconnect through Embedded Signup.', false, 403);
    }
    const scopes = new Set<string>([...(info.scopes || []), ...(info.granular_scopes || []).map((scope: any) => scope.scope)]);
    if (!scopes.has('whatsapp_business_management')) throw new WabaOnboardingError('META_PERMISSION_REQUIRED', 'Grant whatsapp_business_management in the Embedded Signup configuration, then reconnect.', false, 403);
    const ids = new Set<string>((info.granular_scopes || []).filter((scope: any) => scope.scope === 'whatsapp_business_management')
      .flatMap((scope: any) => scope.target_ids || []).filter((id: any) => typeof id === 'string' && /^\d+$/.test(id)));
    if (!ids.size) {
      // Fall back only to assets assigned to this token's system user, never the platform's global client inventory.
      if (typeof info.user_id !== 'string' || !/^\d+$/.test(info.user_id)) throw new WabaOnboardingError(
        'SIGNUP_NO_AUTHORIZED_WABA', 'Meta has not exposed any WABA grants for this signup yet. Setup will recheck the saved authorization.', true, 409);
      try {
        for (const row of await this.list(`${info.user_id}/assigned_whatsapp_business_accounts`, {
          fields: 'id,name', ...(process.env.META_BUSINESS_ID ? { business: process.env.META_BUSINESS_ID } : {}),
        })) if (/^\d+$/.test(row.id)) ids.add(row.id);
      } catch (error: any) {
        if (error.retryable) throw error;
        throw new WabaOnboardingError('WABA_ASSET_DISCOVERY_REQUIRED',
          'Meta returned no granular WABA grants and denied assigned-asset discovery. Check system-user asset assignments, META_BUSINESS_ID and business_management permission if needed for enumeration, then retry or reconnect.', false, 403);
      }
    }
    return { ids: [...ids], scopes };
  }
  async list(path: string, params: Record<string, any> = {}) {
    const rows: any[] = [], cursors = new Set<string>(); let after: string | undefined;
    for (let page = 0; page < 25; page++) {
      const result = await this.call(path, 'GET', { ...params, limit: 100, ...(after ? { after } : {}) });
      if (!Array.isArray(result.data)) throw new WabaOnboardingError('WABA_META_RESPONSE_INVALID', 'Meta returned an incomplete asset list. Retry setup.', true, 502);
      rows.push(...result.data);
      if (!result.paging?.next) return rows;
      const next = result.paging.cursors?.after;
      if (typeof next !== 'string' || !next || cursors.has(next)) break;
      cursors.add(next); after = next;
    }
    throw new WabaOnboardingError('WABA_META_RESPONSE_INVALID', 'Meta asset pagination did not complete. Retry setup.', true, 502);
  }
  getWabaDetails(id: string) { return this.call(id, 'GET', { fields: 'id,name,currency,message_template_namespace' }); }
  async getPhoneNumbers(id: string) {
    return { data: await this.list(`${id}/phone_numbers`, {
      fields: 'id,verified_name,display_phone_number,quality_rating,code_verification_status,status,platform_type,is_on_biz_app',
    }) };
  }
  phone(id: string) { return this.call(id, 'GET', { fields: 'id,status,platform_type,is_on_biz_app,code_verification_status' }); }
  async subscribe(id: string) {
    const { appId } = wabaConfig();
    const hasApp = (rows: any[]) => rows.some(row => String(row.whatsapp_business_api_data?.id ?? row.id) === appId);
    if (hasApp(await this.list(`${id}/subscribed_apps`))) return;
    const result = await this.call(`${id}/subscribed_apps`, 'POST', {}, {});
    if (result.success !== true) throw new WabaOnboardingError('WABA_WEBHOOK_SUBSCRIPTION_PENDING', 'Meta has not confirmed webhook subscription yet.', true, 502);
    const apps = await this.list(`${id}/subscribed_apps`);
    if (!hasApp(apps)) {
      throw new WabaOnboardingError('WABA_WEBHOOK_SUBSCRIPTION_PENDING', 'The app webhook subscription is not visible yet. Setup will retry.', true, 502);
    }
  }
  async register(id: string, pin: string) {
    const response = await this.call(`${id}/register`, 'POST', {}, { messaging_product: 'whatsapp', pin });
    if (response.success !== true) throw new WabaOnboardingError('WABA_REGISTRATION_PENDING', 'Meta has not confirmed phone registration yet.', true, 502);
  }
  async verifyAppWebhooks(coexistence: boolean) {
    const { appId, appSecret } = wabaConfig();
    const callback = process.env.WABA_WEBHOOK_CALLBACK_URL;
    if (!callback || !/^https:\/\//.test(callback) || !process.env.META_WEBHOOK_VERIFY_TOKEN) throw new WabaOnboardingError(
      'WABA_WEBHOOK_CONFIGURATION_REQUIRED', 'Configure WABA_WEBHOOK_CALLBACK_URL (HTTPS) and META_WEBHOOK_VERIFY_TOKEN, then verify that callback in the Meta app dashboard.', false, 503);
    const required = ['messages', 'account_update', ...(coexistence ? ['smb_app_state_sync', 'smb_message_echoes', 'history'] : [])];
    const subscriptions = await new WabaGraph(`${appId}|${appSecret}`, this.heartbeat).list(`${appId}/subscriptions`);
    const subscription = subscriptions.find(row => row.object === 'whatsapp_business_account' && row.callback_url === callback && row.active !== false);
    const fields = new Set((subscription?.fields || []).map((field: any) => typeof field === 'string' ? field : field.name));
    if (!subscription || required.some(field => !fields.has(field))) throw new WabaOnboardingError('WABA_WEBHOOK_CONFIGURATION_REQUIRED',
      `Verify the WhatsApp callback in Meta App Dashboard and subscribe these fields: ${required.join(', ')}. Then retry this saved onboarding.`, false, 409);
  }
}
export default new WabaGraph();
