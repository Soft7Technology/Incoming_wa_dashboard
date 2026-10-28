import axios from 'axios';
import FormData from 'form-data';
import { FacebookError, graphFailure, publicOrigin } from '../utils/facebook';

export const directInstagramPermissions = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
];
export const instagramPublishingPermission = 'instagram_business_content_publish';
export const directInstagramLoginScopes = [...directInstagramPermissions, instagramPublishingPermission];

export function directInstagramConfig() {
  const required = ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'JWT_SECRET', 'FACEBOOK_TOKEN_ENCRYPTION_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length)
    throw new FacebookError(503, `Instagram configuration missing: ${missing.join(', ')}`, 'CONFIGURATION_REQUIRED');
  const { base, secure } = publicOrigin(
    process.env.INSTAGRAM_PUBLIC_URL || process.env.FACEBOOK_PUBLIC_URL,
    'INSTAGRAM_PUBLIC_URL',
  );
  const version = process.env.INSTAGRAM_GRAPH_VERSION || process.env.FACEBOOK_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(version || ''))
    throw new FacebookError(503, 'Set INSTAGRAM_GRAPH_VERSION to an active API version.');
  if (Buffer.from(process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY!, 'base64').length !== 32)
    throw new FacebookError(503, 'FACEBOOK_TOKEN_ENCRYPTION_KEY must encode 32 random bytes in base64.');
  return {
    base,
    secure,
    version,
    appId: process.env.INSTAGRAM_APP_ID!,
    secret: process.env.INSTAGRAM_APP_SECRET!,
    callback: `${base}/v1/facebook/instagram/oauth/callback`,
    mode: 'instagram',
  };
}

export class InstagramGraph {
  private async request(
    url: string,
    method: string,
    token: string | null,
    params: Record<string, unknown> = {},
    data?: unknown,
    headers = {},
  ) {
    try {
      const response = await axios.request({
        url,
        method,
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
        headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        params,
        data,
      });
      if (response.data?.error) throw this.failure(Number(response.data.error.code));
      return response.data;
    } catch (error: any) {
      if (error instanceof FacebookError) throw error;
      if (error.response?.data?.error) throw this.failure(Number(error.response.data.error.code));
      throw new FacebookError(
        502,
        'Instagram did not confirm the request. Check Instagram before repeating an action.',
        'META_UNCONFIRMED',
      );
    }
  }

  private failure(code: number) {
    if (code === 100)
      return new FacebookError(
        400,
        'Instagram rejected the request parameters. Check the selected account, media format and granted permissions.',
        'INSTAGRAM_INVALID_REQUEST',
      );
    if (code === 190)
      return new FacebookError(
        409,
        'Instagram authorization expired or was revoked. Reconnect with Instagram.',
        'TOKEN_EXPIRED',
      );
    if ([10, 200, 299].includes(code))
      return new FacebookError(
        403,
        'Instagram denied access. Reconnect with the required permissions and check the app access level.',
        'PERMISSION_DENIED',
      );
    if (code === 1 || code === 2)
      return new FacebookError(
        503,
        'Instagram could not complete the request. Try refreshing the inbox again shortly.',
        'INSTAGRAM_TEMPORARY_ERROR',
      );
    return graphFailure(code);
  }

  async call(
    path: string,
    token: string,
    method = 'GET',
    params: Record<string, unknown> = {},
    body?: unknown,
  ): Promise<any> {
    if (!/^[A-Za-z0-9_:./-]+$/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..'))
      throw new FacebookError(400, 'Invalid Instagram API path.');
    return this.request(
      `https://graph.instagram.com/${directInstagramConfig().version}/${path}`,
      method,
      token,
      params,
      body,
    );
  }

  async profile(token: string) {
    const profile = await this.call('me', token, 'GET', { fields: 'user_id,username' });
    if (!/^\d{1,80}$/.test(String(profile.user_id || '')) || typeof profile.username !== 'string' || !profile.username)
      throw new FacebookError(502, 'Instagram did not return a professional account identifier and username.');
    return { id: String(profile.user_id), username: profile.username };
  }

  async authorize(code: string, callback: string) {
    const c = directInstagramConfig();
    const form = new FormData();
    for (const [key, value] of Object.entries({
      client_id: c.appId,
      client_secret: c.secret,
      grant_type: 'authorization_code',
      redirect_uri: callback,
      code,
    }))
      form.append(key, value);
    const short = await this.request(
      'https://api.instagram.com/oauth/access_token',
      'POST',
      null,
      {},
      form,
      form.getHeaders(),
    );
    if (typeof short.access_token !== 'string' || !/^\d{1,80}$/.test(String(short.user_id || '')))
      throw new FacebookError(502, 'Instagram did not return a user access token.');
    const long = await this.request('https://graph.instagram.com/access_token', 'GET', null, {
      grant_type: 'ig_exchange_token',
      client_secret: c.secret,
      access_token: short.access_token,
    });
    if (typeof long.access_token !== 'string' || !Number.isFinite(long.expires_in) || long.expires_in <= 0)
      throw new FacebookError(502, 'Instagram did not return a long-lived token and expiration.');
    const profile = await this.profile(long.access_token);
    // Some API versions return permissions with the code exchange. Otherwise
    // account subscription and subsequent API operations enforce the grants.
    const granted = Array.isArray(short.permissions)
      ? short.permissions
      : typeof short.permissions === 'string'
        ? short.permissions.split(',')
        : null;
    return {
      token: long.access_token,
      userId: String(short.user_id),
      profile,
      granted,
      expires: new Date(Date.now() + long.expires_in * 1000),
      appId: c.appId,
    };
  }

  async refresh(token: string) {
    const result = await this.request('https://graph.instagram.com/refresh_access_token', 'GET', null, {
      grant_type: 'ig_refresh_token',
      access_token: token,
    });
    if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in) || result.expires_in <= 0)
      throw new FacebookError(502, 'Instagram did not confirm token renewal. Reconnect.');
    return { token: result.access_token, expires: new Date(Date.now() + result.expires_in * 1000) };
  }
}

export default new InstagramGraph();
