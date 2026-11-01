import axios from 'axios';
import crypto from 'crypto';
import { config, FacebookError, FacebookFeature, graphFailure } from '../utils/facebook';

export class FacebookGraph {
  constructor(
    private readonly versionOverride?: string,
    private readonly feature: FacebookFeature = 'transport',
  ) {}

  async call(
    path: string,
    token: string | null,
    method = 'GET',
    params: Record<string, unknown> = {},
    body?: unknown,
  ): Promise<any> {
    const c = config(this.feature, false);
    const version = this.versionOverride || c.version;
    if (!/^v\d+\.\d+$/.test(version)) throw new FacebookError(503, 'Set an active Facebook API version.');
    try {
      const result = await axios.request({
        url: `https://graph.facebook.com/${version}/${path}`,
        method,
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        params: {
          ...params,
          ...(token ? { appsecret_proof: crypto.createHmac('sha256', c.secret).update(token).digest('hex') } : {}),
        },
        data: body,
      });
      if (result.data?.error) throw graphFailure(Number(result.data.error.code));
      return result.data;
    } catch (error: any) {
      if (error instanceof FacebookError) throw error;
      if (error.response?.data?.error) throw graphFailure(Number(error.response.data.error.code));
      throw new FacebookError(
        502,
        method === 'POST' && path.endsWith('/messages')
          ? 'No confirmation from Meta. The reply may have been sent; check Messenger before sending it again. An echo can still confirm it here.'
          : 'Could not reach Meta. Try again after checking connectivity.',
        'META_UNCONFIRMED',
      );
    }
  }

  async authorize(code: string, callback?: string) {
    const c = config(this.feature, false);
    const short = await this.call('oauth/access_token', null, 'GET', {
      client_id: c.appId,
      client_secret: c.secret,
      redirect_uri: callback || c.callback,
      code,
    });
    if (!short.access_token) throw new FacebookError(502, 'Meta did not return a user access token.');
    const long = await this.call('oauth/access_token', null, 'GET', {
      grant_type: 'fb_exchange_token',
      client_id: c.appId,
      client_secret: c.secret,
      fb_exchange_token: short.access_token,
    });
    if (!long.access_token) throw new FacebookError(502, 'Meta did not return a long-lived user access token.');
    return this.inspectUser(long.access_token);
  }

  async inspectUser(token: string) {
    const c = config(this.feature, false);
    const debug = await this.call('debug_token', `${c.appId}|${c.secret}`, 'GET', { input_token: token });
    if (
      !debug.data?.is_valid ||
      String(debug.data.app_id) !== c.appId ||
      !debug.data.user_id ||
      debug.data.type !== 'USER'
    ) {
      throw new FacebookError(403, 'Use a valid Facebook USER access token generated for this app.');
    }
    const dates = [debug.data.expires_at, debug.data.data_access_expires_at];
    if (dates.some((value) => value && Number(value) * 1000 <= Date.now()))
      throw new FacebookError(
        409,
        'Facebook authorization expired. Generate a new token or reconnect.',
        'TOKEN_EXPIRED',
      );
    const grants = await this.call('me/permissions', token);
    return {
      token,
      userId: String(debug.data.user_id),
      granted: (grants.data || []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission),
      dataExpires: debug.data.data_access_expires_at ? new Date(debug.data.data_access_expires_at * 1000) : null,
    };
  }

  /** Validates the linked Page token used by the optional Instagram-via-Facebook provider. */
  async inspectPage(pageId: string, token: string) {
    const c = config(this.feature, false);
    const debug = await this.call('debug_token', `${c.appId}|${c.secret}`, 'GET', { input_token: token });
    if (!debug.data?.is_valid || String(debug.data.app_id) !== c.appId || debug.data.type !== 'PAGE')
      throw new FacebookError(409, 'Invalid linked Page authorization. Reconnect.', 'TOKEN_EXPIRED');
    if (String(debug.data.profile_id) !== pageId)
      throw new FacebookError(403, 'Meta returned a token for a different linked Page.');
    return {
      expires: debug.data.expires_at ? new Date(debug.data.expires_at * 1000) : null,
      granted: Array.isArray(debug.data.scopes) ? (debug.data.scopes as string[]) : [],
    };
  }

}

export default new FacebookGraph();
