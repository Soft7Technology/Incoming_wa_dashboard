import axios from 'axios';
import { createHmac } from 'crypto';
import { CustomError } from '@surefy/exceptions/CustomError';
import type { FacebookFeature } from './facebookOAuth.service';
import { graphFailure } from '../utils/facebook';

type SubscriptionResponse = {
  success?: boolean;
  error?: { code?: number };
  data?: Array<{ id: string; subscribed_fields?: string[] }>;
  paging?: { next?: string; cursors?: { after?: string } };
};

class FacebookLeadSubscriptionService {
  async ensureSubscribed(pageId: string, token: string, feature: FacebookFeature = 'leads'): Promise<void> {
    const appId = feature === 'leads'
      ? process.env.FACEBOOK_LEADS_APP_ID || process.env.FACEBOOK_APP_ID
      : process.env.FACEBOOK_MESSENGER_APP_ID;
    const secret = feature === 'leads'
      ? process.env.FACEBOOK_LEADS_APP_SECRET || process.env.FACEBOOK_APP_SECRET
      : process.env.FACEBOOK_MESSENGER_APP_SECRET;
    const field = feature === 'leads' ? 'leadgen' : 'messages';
    const version = process.env.FACEBOOK_GRAPH_VERSION;

    if (!/^\d+$/.test(appId || '') || !secret || !version || !/^v\d+\.\d+$/.test(version)) {
      throw new CustomError(`Facebook ${feature} subscription configuration is incomplete.`, 503);
    }
    if (!/^\d{1,80}$/.test(pageId) || !token) {
      throw new CustomError('A valid Facebook Page and token are required.', 400);
    }

    const url = `https://graph.facebook.com/${version}/${pageId}/subscribed_apps`;
    const proof = createHmac('sha256', secret).update(token).digest('hex');

    const request = async (
      method: 'GET' | 'POST',
      params: Record<string, unknown> = {},
      fields?: string[],
    ): Promise<SubscriptionResponse> => {
      try {
        const response = await axios.request<SubscriptionResponse>({
          url,
          method,
          headers: { Authorization: `Bearer ${token}` },
          params: { ...params, appsecret_proof: proof },
          data: fields ? { subscribed_fields: fields.join(',') } : undefined,
          timeout: 15000,
          maxRedirects: 0,
          maxContentLength: 1024 * 1024,
        });
        if (response.data?.error) {
          const safe = graphFailure(Number(response.data.error.code));
          throw new CustomError(safe.message, safe.status);
        }
        if (!response.data) throw new CustomError('Meta returned an empty subscription response.', 502);
        return response.data;
      } catch (error: unknown) {
        if (error instanceof CustomError) throw error;
        const code = axios.isAxiosError(error) ? error.response?.data?.error?.code : undefined;
        if (code !== undefined) {
          const safe = graphFailure(Number(code));
          throw new CustomError(safe.message, safe.status);
        }
        // Never propagate Axios errors containing Page credentials.
        throw new CustomError('Could not confirm the Facebook Page subscription. Retry connecting the Page.', 502);
      }
    };

    const readFields = async (): Promise<string[]> => {
      const seen = new Set<string>();
      let after: string | undefined;
      do {
        const result = await request('GET', {
          fields: 'id,subscribed_fields',
          limit: 100,
          ...(after ? { after } : {}),
        });
        if (!Array.isArray(result.data)) {
          throw new CustomError('Meta returned invalid Page subscriptions.', 502);
        }
        const app = result.data.find((item) => String(item.id) === appId);
        if (app) {
          if (!Array.isArray(app.subscribed_fields) ||
              !app.subscribed_fields.every((field) => typeof field === 'string')) {
            throw new CustomError('Meta did not return the subscribed Page fields.', 502);
          }
          return app.subscribed_fields;
        }
        if (!result.paging?.next) return [];
        const cursor = result.paging.cursors?.after;
        if (!cursor || typeof cursor !== 'string' || seen.has(cursor)) {
          throw new CustomError('Meta returned invalid subscription pagination.', 502);
        }
        seen.add(cursor);
        after = cursor;
      } while (after);
      return [];
    };

    // Preserve other subscriptions when the app also serves another integration.
    const existing = await readFields();
    if (existing.includes(field)) return;
    const required = [...new Set([...existing, field])];
    const result = await request('POST', {}, required);
    if (result.success !== true) {
      throw new CustomError('Meta did not accept the Page subscription.', 502);
    }
    const confirmed = await readFields();
    if (!required.every((field) => confirmed.includes(field))) {
      throw new CustomError('Meta did not confirm the Page subscription. Retry connecting the Page.', 502);
    }
  }
}

export default new FacebookLeadSubscriptionService();
