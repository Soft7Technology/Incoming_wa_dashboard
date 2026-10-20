import axios from 'axios';
import { configuration, fail, shopDomain } from '../utils/shopify';

export class ShopifyClient {
  private async request(shop: string, path: string, body: unknown, token?: string) {
    try {
      const response = await axios.post(`https://${shopDomain(shop)}${path}`, body, {
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Shopify-Access-Token': token } : {}) },
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 1024 * 1024,
      });
      return response.data;
    } catch (error: any) {
      // Axios errors contain credentials and request bodies. Never forward/log them.
      const status = error?.response?.status;
      if (status === 401) fail(401, 'Shopify authorization expired or was revoked. Reconnect the store.');
      if (status === 403) fail(403, 'Shopify denied access. Check app permissions and customer data approval.');
      if (status === 429) fail(429, 'Shopify API quota exceeded. Wait and try again.');
      fail(502, 'Shopify request failed. Check the store domain and try again.');
    }
  }
  async exchange(shop: string, code: string) {
    const c = configuration();
    return this.request(shop, '/admin/oauth/access_token', {
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code,
      expiring: 1,
    });
  }
  async refresh(shop: string, token: string) {
    const c = configuration();
    return this.request(shop, '/admin/oauth/access_token', {
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: token,
    });
  }
  async graphql(shop: string, token: string, query: string, variables: Record<string, unknown> = {}) {
    const data = await this.request(
      shop,
      `/admin/api/${configuration().apiVersion}/graphql.json`,
      { query, variables },
      token,
    );
    if (data?.errors?.length || !data?.data)
      fail(403, 'Shopify could not complete this operation. Check permissions and app approval.');
    return data.data;
  }
  async identity(shop: string, token: string) {
    return this.graphql(
      shop,
      token,
      `query { shop { id name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`,
    );
  }
  async subscriptions(shop: string, token: string) {
    const nodes: any[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data: any = await this.graphql(
        shop,
        token,
        `query($after: String) {
        webhookSubscriptions(first: 250, after: $after) { nodes { id topic uri } pageInfo { hasNextPage endCursor } }
      }`,
        { after },
      );
      nodes.push(...data.webhookSubscriptions.nodes);
      if (!data.webhookSubscriptions.pageInfo.hasNextPage) return nodes;
      after = data.webhookSubscriptions.pageInfo.endCursor;
    }
    return fail(409, 'Too many Shopify webhook subscriptions. Review existing subscriptions before retrying.');
  }
  async subscribe(shop: string, token: string, topic: string, uri: string) {
    const data = await this.graphql(
      shop,
      token,
      `mutation($topic: WebhookSubscriptionTopic!, $input: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $input) {
        webhookSubscription { id topic uri } userErrors { field message }
      }
    }`,
      { topic, input: { uri, format: 'JSON' } },
    );
    if (data.webhookSubscriptionCreate.userErrors?.length || !data.webhookSubscriptionCreate.webhookSubscription)
      fail(403, 'Shopify refused the webhook subscription. Check scopes and protected customer data approval.');
    return data.webhookSubscriptionCreate.webhookSubscription;
  }
  async unsubscribe(shop: string, token: string, id: string) {
    const data = await this.graphql(
      shop,
      token,
      `mutation($id: ID!) {
      webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } }
    }`,
      { id },
    );
    if (data.webhookSubscriptionDelete.userErrors?.length)
      fail(502, 'Shopify could not remove a webhook subscription. Retry.');
  }
}
