import axios from 'axios';
import crypto from 'crypto';
import { config, FacebookError, graphFailure } from '../utils/facebook';

export class FacebookGraph {
  async call(
    path: string,
    token: string | null,
    method = 'GET',
    params: Record<string, unknown> = {},
    body?: unknown,
  ): Promise<any> {
    const c = config();
    try {
      const result = await axios.request({
        url: `https://graph.facebook.com/${c.version}/${path}`,
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

  async authorize(code: string) {
    const c = config();
    const short = await this.call('oauth/access_token', null, 'GET', {
      client_id: c.appId,
      client_secret: c.secret,
      redirect_uri: c.callback,
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
    const token = long.access_token;
    const debug = await this.call('debug_token', `${c.appId}|${c.secret}`, 'GET', { input_token: token });
    if (
      !debug.data?.is_valid ||
      String(debug.data.app_id) !== c.appId ||
      !debug.data.user_id ||
      debug.data.type !== 'USER'
    ) {
      throw new FacebookError(403, 'Configure Facebook Login to issue a user access token for this app.');
    }
    const grants = await this.call('me/permissions', token);
    return {
      token,
      userId: String(debug.data.user_id),
      granted: (grants.data || []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission),
      dataExpires: debug.data.data_access_expires_at ? new Date(debug.data.data_access_expires_at * 1000) : null,
    };
  }

  async pages(token: string) {
    const pages: any[] = [];
    let after: string | undefined;
    for (let i = 0; i < 100; i++) {
      const response = await this.call('me/accounts', token, 'GET', {
        fields: 'id,name,access_token,tasks',
        limit: 100,
        ...(after ? { after } : {}),
      });
      pages.push(...(response.data || []));
      if (!response.paging?.next) {
        if (!pages.length)
          throw new FacebookError(
            403,
            'Facebook approved the app permissions but returned no Pages for this account. Check that the selected Page is assigned to the Facebook account you used to log in and is selected in this app\'s Business Integration, then connect again.',
            'NO_PAGES_RETURNED',
          );
        const messagingPages = pages.filter((p) =>
          (p.tasks || []).some((t: string) => ['MESSAGE', 'MESSAGING', 'PROFILE_PLUS_MESSAGING'].includes(t)),
        );
        if (!messagingPages.length)
          throw new FacebookError(
            403,
            `Facebook returned ${pages.length} Page(s), but none grants your Facebook account messaging access. Ask the Page owner to enable Messages and Community Activity for your account in Page access, then connect again.`,
            'PAGE_MESSAGING_ACCESS_REQUIRED',
          );
        const eligible = messagingPages.filter((p) => p.access_token);
        if (!eligible.length)
          throw new FacebookError(
            403,
            'Facebook returned Pages with messaging access but did not provide a usable Page access token. Check the selected Page and its permissions in this app\'s Business Integration, then connect again.',
            'PAGE_TOKEN_MISSING',
          );
        return eligible;
      }
      after = response.paging.cursors?.after;
      if (!after) break;
    }
    throw new FacebookError(502, 'Meta Page list pagination could not be completed.');
  }

  async inspectPage(pageId: string, token: string) {
    const c = config();
    // Page metadata reads require pages_read_engagement. The token debugger can
    // verify the authorized Page without adding a permission to Messenger login.
    const debug = await this.call('debug_token', `${c.appId}|${c.secret}`, 'GET', { input_token: token });
    if (!debug.data?.is_valid || String(debug.data.app_id) !== c.appId || debug.data.type !== 'PAGE')
      throw new FacebookError(409, 'Invalid Page authorization. Reconnect.', 'TOKEN_EXPIRED');
    if (String(debug.data.profile_id) !== pageId)
      throw new FacebookError(403, 'Meta returned a token for a different Page.');
    return { expires: debug.data.expires_at ? new Date(debug.data.expires_at * 1000) : null };
  }
}

export default new FacebookGraph();
