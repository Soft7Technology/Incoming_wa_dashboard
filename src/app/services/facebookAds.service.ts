import { Knex } from 'knex';
import db from '@surefy/database';
import { FacebookGraph } from './facebookGraph.service';
import { FacebookMessengerService, FacebookScope } from './facebookMessenger.service';
import { config, decrypt, encrypt, FacebookError, hash, random, uuidPattern } from '../utils/facebook';

export const adsPermissions = ['business_management', 'ads_read', 'ads_management', 'pages_show_list', 'pages_read_engagement'];
const metaId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,80}$/.test(value);
const accountId = (value: unknown): value is string => typeof value === 'string' && /^act_\d{1,80}$/.test(value);
const owned = (scope: FacebookScope) => ({ company_id: scope.companyId, owner_id: scope.ownerId });

export function adsConfig() {
  const c = config('transport');
  const version = process.env.FACEBOOK_ADS_GRAPH_VERSION || c.version;
  if (!/^v\d+\.\d+$/.test(version)) throw new FacebookError(503, 'Set FACEBOOK_ADS_GRAPH_VERSION to an active Marketing API version.');
  const loginConfigId = process.env.FACEBOOK_ADS_LOGIN_CONFIG_ID || process.env.FACEBOOK_LOGIN_CONFIG_ID;
  if (process.env.FACEBOOK_ADS_LOGIN_MODE !== 'classic' && !/^\d+$/.test(loginConfigId || ''))
    throw new FacebookError(503, 'Configure FACEBOOK_ADS_LOGIN_CONFIG_ID or FACEBOOK_LOGIN_CONFIG_ID with the Business & Ads permissions, or set FACEBOOK_ADS_LOGIN_MODE=classic for an app supporting classic login.');
  return { ...c, version, loginConfigId, callback: `${c.base}/v1/facebook/ads/oauth/callback` };
}

export class FacebookAdsService {
  constructor(private database: Knex = db, private meta: FacebookGraph = new FacebookGraph(process.env.FACEBOOK_ADS_GRAPH_VERSION)) {}

  async access(scope: FacebookScope) {
    if (scope.reviewPageId) throw new FacebookError(403, 'Open your own Business & Ads workspace.');
    await new FacebookMessengerService(this.database, this.meta).access(scope, 'manage');
  }

  async start(scope: FacebookScope) {
    await this.access(scope);
    const c = adsConfig(), state = random(), browser = random();
    await this.database('facebook_ads_oauth').where('expires_at', '<', new Date()).delete();
    await this.database('facebook_ads_oauth').insert({ ...owned(scope), state_hash: hash(state), browser_hash: hash(browser),
      expires_at: new Date(Date.now() + 15 * 60 * 1000) });
    const url = new URL(`https://www.facebook.com/${c.version}/dialog/oauth`);
    const params: Record<string, string> = { client_id: c.appId, redirect_uri: c.callback, state, response_type: 'code' };
    if (process.env.FACEBOOK_ADS_LOGIN_MODE === 'classic') {
      params.scope = adsPermissions.join(',');
      params.auth_type = 'rerequest';
    } else {
      params.config_id = c.loginConfigId!;
      params.override_default_response_type = 'true';
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { browser, url: url.toString() };
  }

  async callback(state: unknown, browser: string | undefined, code: unknown, cancelled: boolean) {
    if (typeof state !== 'string' || !browser) throw new FacebookError(403, 'Facebook login session is missing. Connect again.');
    const [session] = await this.database('facebook_ads_oauth')
      .where({ state_hash: hash(state), browser_hash: hash(browser), status: 'started' })
      .where('expires_at', '>', new Date()).update({ status: 'authorizing' }).returning('*');
    if (!session) throw new FacebookError(403, 'Facebook login expired or was already used. Connect again.');
    try {
      const scope = { companyId: session.company_id, ownerId: session.owner_id, userId: session.owner_id };
      await this.access(scope);
      if (cancelled) throw new FacebookError(400, 'Facebook login was cancelled.');
      if (typeof code !== 'string' || !code) throw new FacebookError(400, 'Facebook did not return an authorization code.');
      const auth = await this.meta.authorize(code, adsConfig().callback);
      const missing = adsPermissions.filter(p => !auth.granted.includes(p));
      if (missing.length) throw new FacebookError(403, `Missing permissions: ${missing.join(', ')}. Check the login configuration and reconnect.`);
      await this.database.transaction(async trx => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`facebook-ads:${scope.companyId}:${scope.ownerId}`]);
        const current = await trx('facebook_ads_oauth').where({ state_hash: session.state_hash, status: 'authorizing' })
          .where('expires_at', '>', new Date()).forUpdate().first();
        if (!current) throw new FacebookError(409, 'The connection request was removed or expired. Connect again.');
        const row = { ...owned(scope), facebook_user_id: auth.userId, token_ciphertext: encrypt(auth.token),
          permissions: JSON.stringify(auth.granted), data_expires_at: auth.dataExpires, connected_at: new Date() };
        const existing = await trx('facebook_ads_connections').where(owned(scope)).first();
        if (existing) await trx('facebook_ads_connections').where({ id: existing.id }).update(row);
        else await trx('facebook_ads_connections').insert(row);
        await trx('facebook_ads_oauth').where({ state_hash: session.state_hash }).update({ status: 'ready', error: null });
      });
      return 'ready';
    } catch (error) {
      await this.database('facebook_ads_oauth').where({ state_hash: session.state_hash }).update({ status: 'failed',
        error: error instanceof FacebookError ? error.message : 'Facebook authorization failed. Connect again.' });
      return 'failed';
    }
  }

  async status(scope: FacebookScope, browser?: string) {
    await this.access(scope);
    const connection = await this.database('facebook_ads_connections').where(owned(scope)).first();
    const session = browser ? await this.database('facebook_ads_oauth').where({ ...owned(scope), browser_hash: hash(browser) })
      .where('expires_at', '>', new Date()).orderBy('expires_at', 'desc').first() : null;
    return { connected: Boolean(connection), permissions: connection?.permissions || [], error: session?.error || null,
      connected_at: connection?.connected_at || null };
  }

  async connection(scope: FacebookScope, database = this.database) {
    await this.access(scope);
    const row = await database('facebook_ads_connections').where(owned(scope)).first();
    if (!row) throw new FacebookError(409, 'Connect Facebook to access your business and ads.');
    if (row.data_expires_at && new Date(row.data_expires_at).getTime() <= Date.now())
      throw new FacebookError(409, 'Facebook data access expired. Reconnect Facebook.');
    return { ...row, token: decrypt(row.token_ciphertext) };
  }

  async list(path: string, token: string, fields: string) {
    const rows: any[] = [];
    let after: string | undefined;
    for (let i = 0; i < 100; i++) {
      const response = await this.meta.call(path, token, 'GET', { fields, limit: 100, ...(after ? { after } : {}) });
      rows.push(...(response.data || []));
      if (!response.paging?.next) return rows;
      const next = response.paging?.cursors?.after;
      if (typeof next !== 'string' || next === after) break;
      after = next;
    }
    throw new FacebookError(502, 'Meta returned an incomplete list. Try a smaller business account.');
  }

  async businesses(scope: FacebookScope) {
    const c = await this.connection(scope);
    return this.list('me/businesses', c.token, 'id,name');
  }

  async accountsFor(token: string, business: unknown) {
    if (!metaId(business)) throw new FacebookError(400, 'Select a business portfolio.');
    const businesses = await this.list('me/businesses', token, 'id,name');
    if (!businesses.some(row => String(row.id) === business)) throw new FacebookError(403, 'This business was not authorized.');
    const fields = 'id,name,account_id,currency,account_status';
    const ownedAccounts = await this.list(`${business}/owned_ad_accounts`, token, fields);
    const clientAccounts = await this.list(`${business}/client_ad_accounts`, token, fields);
    return [...new Map([...ownedAccounts, ...clientAccounts].map(row => [row.id, row])).values()];
  }

  async accounts(scope: FacebookScope, business: unknown) {
    const c = await this.connection(scope);
    return this.accountsFor(c.token, business);
  }

  async account(scope: FacebookScope, business: unknown, account: unknown) {
    if (!accountId(account)) throw new FacebookError(400, 'Select an ad account.');
    const c = await this.connection(scope);
    const accounts = await this.accountsFor(c.token, business);
    if (!accounts.some(row => row.id === account)) throw new FacebookError(403, 'This ad account is not in the selected business.');
    return c;
  }

  async campaigns(scope: FacebookScope, business: unknown, account: unknown) {
    const c = await this.account(scope, business, account);
    return this.list(`${account}/campaigns`, c.token, 'id,name,status,objective');
  }

  async insights(scope: FacebookScope, business: unknown, account: unknown, period: unknown) {
    if (!['last_7d', 'last_30d', 'last_90d'].includes(String(period))) throw new FacebookError(400, 'Select a supported reporting period.');
    const c = await this.account(scope, business, account);
    const response = await this.meta.call(`${account}/insights`, c.token, 'GET', {
      fields: 'account_id,account_name,spend,impressions,reach,clicks,actions', date_preset: period, level: 'account', limit: 1,
    });
    return { rows: response.data || [], period };
  }

  async create(scope: FacebookScope, business: unknown, account: unknown, input: any) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 200 || !uuidPattern.test(input?.client_request_id || ''))
      throw new FacebookError(400, 'Enter a campaign name (up to 200 characters) and a valid request ID.');
    const c = await this.account(scope, business, account);
    const requestHash = hash(JSON.stringify({ business, account, name }));
    return this.database.transaction(async trx => {
      // Hold the connection lock through creation so disconnect/revocation cannot
      // race a new mutation. The request record prevents retry duplicates.
      const active = await trx('facebook_ads_connections').where({ id: c.id, ...owned(scope) }).forUpdate().first();
      if (!active) throw new FacebookError(409, 'The connection was removed. Reconnect Facebook.');
      const prior = await trx('facebook_ads_actions').where({ id: input.client_request_id }).first();
      if (prior) {
        if (prior.connection_id !== c.id || prior.request_hash !== requestHash)
          throw new FacebookError(409, 'This request ID was already used for another campaign.');
        return { status: prior.status, campaign_id: prior.campaign_id };
      }
      await trx('facebook_ads_actions').insert({ id: input.client_request_id, connection_id: c.id,
        account_id: account, request_hash: requestHash, status: 'unconfirmed' });
      try {
        const result = await this.meta.call(`${account}/campaigns`, decrypt(active.token_ciphertext), 'POST', {}, {
          name, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false,
        });
        if (!metaId(result.id)) return { status: 'unconfirmed', campaign_id: null };
        await trx('facebook_ads_actions').where({ id: input.client_request_id })
          .update({ status: 'confirmed', campaign_id: result.id });
        return { status: 'confirmed', campaign_id: result.id };
      } catch (error) {
        // A network timeout can follow a successful Meta write. Never resend it.
        const status = error instanceof FacebookError && error.code !== 'META_UNCONFIRMED' ? 'failed' : 'unconfirmed';
        await trx('facebook_ads_actions').where({ id: input.client_request_id }).update({ status });
        return { status, campaign_id: null };
      }
    });
  }

  async disconnect(scope: FacebookScope) {
    await this.access(scope);
    await this.database.transaction(async trx => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`facebook-ads:${scope.companyId}:${scope.ownerId}`]);
      await trx('facebook_ads_oauth').where(owned(scope)).delete();
      await trx('facebook_ads_connections').where(owned(scope)).delete();
    });
    return { disconnected: true };
  }
}

export default new FacebookAdsService();
