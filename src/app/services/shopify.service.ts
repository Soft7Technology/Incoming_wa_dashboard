import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import db from '@surefy/database';
import { ShopifyClient } from './shopifyClient.service';
import { enqueueShopifyMessage } from '../utils/shopifyMessaging';
import {
  ShopifyScope,
  compliance,
  flowTestTopics,
  configuration,
  decrypt,
  encrypt,
  equalSecret,
  fail,
  hash,
  identifier,
  lifecycle,
  owner,
  random,
  shopDomain,
  topics,
  verifyCallback,
  verifyWebhook,
  scalarId,
  minimizePayload,
  subjectHashes,
  expiresAt,
} from '../utils/shopify';

const where = (scope: ShopifyScope) => ({ company_id: scope.companyId, owner_id: scope.ownerId });
const context = (connection: any) => `${connection.company_id}:${connection.owner_id}:${connection.shop_domain}`;
const nonce = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const matching = (query: Knex.QueryBuilder, hashes: string[]) =>
  hashes.length
    ? query.where(function () {
        for (const h of hashes) this.orWhereJsonSupersetOf('subject_hashes', [h]);
      })
    : query.whereRaw('false');
const tokenFields = (tokens: any, ctx: string, existingScopes: string[] = []) => {
  if (
    typeof tokens?.access_token !== 'string' ||
    !tokens.access_token ||
    tokens.access_token.length > 16384 ||
    typeof tokens.refresh_token !== 'string' ||
    !tokens.refresh_token ||
    tokens.refresh_token.length > 16384 ||
    !Number.isFinite(Number(tokens.expires_in)) ||
    Number(tokens.expires_in) <= 0 ||
    Number(tokens.expires_in) > 31536000 ||
    !Number.isFinite(Number(tokens.refresh_token_expires_in)) ||
    Number(tokens.refresh_token_expires_in) <= 0
  )
    fail(502, 'Shopify did not return valid expiring offline credentials. Reconnect the store.');
  const scopes =
    typeof tokens.scope === 'string' ? tokens.scope.split(',').map((s: string) => s.trim()) : existingScopes;
  return {
    access_token_ciphertext: encrypt(tokens.access_token, ctx),
    refresh_token_ciphertext: encrypt(tokens.refresh_token, ctx),
    token_expires_at: new Date(Date.now() + Number(tokens.expires_in) * 1000),
    refresh_expires_at: new Date(Date.now() + Number(tokens.refresh_token_expires_in) * 1000),
    scopes: JSON.stringify(scopes),
  };
};
const clientTokenFields = (tokens: any, ctx: string) => {
  const seconds = Number(tokens?.expires_in);
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 16384 ||
      !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400)
    fail(502, 'Shopify did not return a valid expiring app access token');
  return { access_token_ciphertext: encrypt(tokens.access_token, ctx), token_expires_at: new Date(Date.now() + seconds * 1000),
    refresh_token_ciphertext: null, refresh_expires_at: null };
};

export class ShopifyService {
  constructor(
    private database: Knex = db,
    private shopify: ShopifyClient = new ShopifyClient(),
    private flowReceiver?: { flowId: string; token: string },
  ) {}
  private async flowBinding(database: Knex | Knex.Transaction = this.database) {
    const auth = this.flowReceiver!;
    if (!nonce(auth.token)) fail(401, 'Invalid Shopify flow webhook destination.');
    const binding = await database('shopify_flow_webhooks')
      .where({ flow_id: identifier(auth.flowId), enabled: true, token_hash: hash(auth.token) })
      .where('expires_at', '>', new Date())
      .first();
    if (!binding?.signing_secret_ciphertext) fail(401, 'Shopify test webhook is invalid, disabled or expired.');
    return binding;
  }
  private async lock(trx: Knex.Transaction, shop: string) {
    // OAuth acquisition and refresh retire each other's credentials. Serialize both per store.
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`shopify:${shop}`]);
  }
  private async owned(scope: ShopifyScope, id: unknown, database: Knex | Knex.Transaction = this.database) {
    owner(scope);
    const record = await database('shopify_connections')
      .where({ ...where(scope), id: identifier(id) })
      .first();
    if (!record) fail(404, 'Shopify connection not found in your account.');
    return record;
  }
  private async appCredentials(scope: ShopifyScope, connection: any, database: Knex | Knex.Transaction = this.database) {
    if (!await database.schema.hasTable('shopify_app_credentials')) return null;
    const row = await database('shopify_app_credentials').where({ connection_id: connection.id }).first();
    if (!row) return null;
    if (row.owner_id !== scope.ownerId || row.company_id !== scope.companyId)
      fail(503, 'Saved Shopify app credentials do not match this account');
    return { clientId: row.client_id, clientSecret: decrypt(row.client_secret_ciphertext, `${context(connection)}:client:${row.client_id}`) };
  }
  async automationSigningSecret(scope: ShopifyScope, id: unknown) {
    const connection = await this.owned(scope, id);
    if (connection.status !== 'connected') fail(409, 'Reconnect this Shopify store first');
    return (await this.appCredentials(scope, connection))?.clientSecret || configuration().clientSecret;
  }
  async connectClientCredentials(scope: ShopifyScope, input: Record<string, unknown>) {
    owner(scope);
    if (Object.keys(input).some(key => !['shop', 'name', 'client_id', 'client_secret'].includes(key)))
      fail(400, 'Use shop, name, client_id and client_secret for a Shopify connection');
    const shop = shopDomain(input.shop);
    const field = (value: unknown, name: string, max: number) => {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `${name} is required and must be at most ${max} characters`);
      return (value as string).trim();
    };
    const clientId = field(input.client_id, 'client_id', 255), clientSecret = field(input.client_secret, 'client_secret', 1024);
    const name = input.name === undefined ? shop : field(input.name, 'name', 120);
    if (clientSecret.length < 16) fail(400, 'client_secret must contain at least 16 characters');
    if (!await this.database.schema.hasTable('shopify_app_credentials'))
      fail(503, 'Shopify client-credential connections are not enabled on this server yet');
    return this.database.transaction(async trx => {
      await this.lock(trx, shop);
      const prior = await trx('shopify_connections').where({ shop_domain: shop }).first();
      if (prior && (prior.owner_id !== scope.ownerId || prior.company_id !== scope.companyId))
        fail(409, 'This store is already linked to another account');
      const previousApp = prior ? await this.appCredentials(scope, prior, trx) : null;
      if (prior?.status === 'connected' && (!previousApp || previousApp.clientId !== clientId))
        fail(409, 'This store already uses another Shopify app connection. Use that connection, or disconnect it before changing apps.');
      const tokens = await this.shopify.clientCredentials(shop, clientId, clientSecret);
      const base = { company_id: scope.companyId, owner_id: scope.ownerId, shop_domain: shop }, ctx = context(base);
      const credentials = clientTokenFields(tokens, ctx);
      const identity = await this.shopify.identity(shop, tokens.access_token);
      if (identity?.shop?.myshopifyDomain !== shop || typeof identity.shop.id !== 'string')
        fail(403, 'Shopify returned another store identity; check the app installation');
      const scopes = identity.currentAppInstallation?.accessScopes;
      if (!Array.isArray(scopes) || scopes.length > 256 || scopes.some((item: any) => typeof item?.handle !== 'string'))
        fail(502, 'Shopify did not return the granted app permissions');
      const record = { ...base, ...credentials, id: prior?.id || randomUUID(), shop_id: identity.shop.id, name,
        status: 'connected', scopes: JSON.stringify(scopes.map((item: any) => item.handle)),
        desired_topics: JSON.stringify(prior?.desired_topics || []),
        delivery_token_ciphertext: prior?.delivery_token_ciphertext || encrypt(random(), ctx),
        subscription_issue: null, connected_at: new Date(), updated_at: new Date() };
      const [saved] = await trx('shopify_connections').insert(record).onConflict('shop_domain').merge(record).returning('*');
      await trx('shopify_app_credentials').insert({ connection_id: saved.id, company_id: scope.companyId,
        owner_id: scope.ownerId, client_id: clientId,
        client_secret_ciphertext: encrypt(clientSecret, `${ctx}:client:${clientId}`), updated_at: new Date(),
      }).onConflict('connection_id').merge(['client_id', 'client_secret_ciphertext', 'updated_at']);
      return { id: saved.id, _id: saved.id, appKey: 'shopify', name: saved.name, shop_domain: shop, status: 'connected',
        authentication: 'client_credentials', client_id: clientId, credentials_configured: true,
        token_expires_at: saved.token_expires_at, scopes: scopes.map((item: any) => item.handle) };
    });
  }
  async start(scope: ShopifyScope, body: any) {
    owner(scope);
    const c = configuration(),
      shop = shopDomain(body?.shop);
    const name = body?.name === undefined ? shop : body.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 120)
      fail(400, 'Connection name must contain 1 to 120 characters.');
    const existing = await this.database('shopify_connections').where({ shop_domain: shop }).first();
    if (existing && (existing.company_id !== scope.companyId || existing.owner_id !== scope.ownerId))
      fail(409, 'This store is already linked to another RSVPDesk account.');
    if (existing?.status === 'connected' && await this.appCredentials(scope, existing))
      fail(409, 'Disconnect the current app-credential connection before switching to platform OAuth');
    const state = random(),
      browser = random();
    await this.database('shopify_oauth_sessions').where('expires_at', '<', new Date()).delete();
    await this.database('shopify_oauth_sessions').insert({
      ...where(scope),
      state_hash: hash(state),
      browser_hash: hash(browser),
      shop_domain: shop,
      name: name.trim(),
      client_id: c.clientId,
      expires_at: new Date(Date.now() + 600000),
    });
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    Object.entries({ client_id: c.clientId, scope: c.scopes.join(','), redirect_uri: c.redirectUri, state }).forEach(
      ([k, v]) => url.searchParams.set(k, v),
    );
    return { browser, authorization_url: url.toString() };
  }
  async callback(query: Record<string, unknown>, browser: unknown) {
    const q = verifyCallback(query),
      shop = shopDomain(q.shop),
      c = configuration();
    if (!nonce(q.state) || !nonce(browser)) fail(400, 'Missing Shopify browser session. Start Connect Shopify again.');
    if (!q.code || q.code.length > 4096)
      fail(400, 'Shopify authorization was not completed. Start Connect Shopify again.');
    const connection = await this.database.transaction(async (trx) => {
      await this.lock(trx, shop);
      const [session] = await trx('shopify_oauth_sessions')
        .where({
          state_hash: hash(q.state),
          browser_hash: hash(browser as string),
          shop_domain: shop,
          client_id: c.clientId,
        })
        .whereNull('consumed_at')
        .where('expires_at', '>', new Date())
        .update({ consumed_at: new Date() })
        .returning('*');
      if (!session) fail(400, 'Shopify authorization expired or was already used.');
      const user = await trx('users')
        .where({ id: session.owner_id, company_id: session.company_id, status: 'active' })
        .whereNull('deleted_at')
        .first();
      const company = await trx('companies')
        .where({ id: session.company_id, status: 'active' })
        .whereNull('deleted_at')
        .first();
      if (!user || !company) fail(403, 'The RSVPDesk account is inactive.');
      const prior = await trx('shopify_connections').where({ shop_domain: shop }).first();
      if (prior && (prior.company_id !== session.company_id || prior.owner_id !== session.owner_id))
        fail(409, 'This store is already linked to another RSVPDesk account.');
      if (prior?.status === 'connected' && await this.appCredentials({ companyId: session.company_id, ownerId: session.owner_id, userId: session.owner_id }, prior, trx))
        fail(409, 'Disconnect the current app-credential connection before switching to platform OAuth');
      const base = { company_id: session.company_id, owner_id: session.owner_id, shop_domain: shop },
        ctx = context(base);
      const tokens = await this.shopify.exchange(shop, q.code),
        credentials = tokenFields(tokens, ctx);
      const identity = await this.shopify.identity(shop, tokens.access_token);
      if (shopDomain(identity.shop?.myshopifyDomain) !== shop || !identity.shop?.id)
        fail(401, 'Shopify returned a different store identity.');
      const granted: string[] = identity.currentAppInstallation?.accessScopes?.map((s: any) => s.handle) || [];
      if (c.scopes.some((s) => !granted.includes(s))) fail(403, 'Required Shopify permissions were not approved.');
      const record = {
        ...base,
        ...credentials,
        scopes: JSON.stringify(granted),
        name: session.name,
        shop_id: identity.shop.id,
        status: 'connected',
        subscription_issue: null,
        connected_at: new Date(),
        desired_topics: JSON.stringify(prior?.desired_topics || []),
        delivery_token_ciphertext: prior?.delivery_token_ciphertext || encrypt(random(), ctx),
        updated_at: new Date(),
      };
      const [saved] = await trx('shopify_connections')
        .insert(record)
        .onConflict('shop_domain')
        .merge(record)
        .returning('*');
      return saved;
    });
    // Callback succeeds even if Shopify requires subscription approval; dashboard exposes the issue and retry.
    let warning: string | null = null;
    try {
      await this.sync(
        { companyId: connection.company_id, ownerId: connection.owner_id, userId: connection.owner_id },
        connection.id,
      );
    } catch {
      warning = 'Store connected. Webhook setup needs attention; retry Save triggers in the dashboard.';
    }
    return { connected: true, connection_id: connection.id, warning };
  }
  async connections(scope: ShopifyScope) {
    owner(scope);
    const connections = await this.database('shopify_connections')
      .where(where(scope))
      .select(
        'id',
        'shop_domain',
        'shop_id',
        'name',
        'status',
        'scopes',
        'desired_topics',
        'subscription_issue',
        'token_expires_at',
        'created_at',
        'updated_at',
      )
      .orderBy('created_at', 'desc');
    const ids = connections.map((c) => c.id);
    const subscriptions = ids.length
      ? await this.database('shopify_subscriptions').whereIn('connection_id', ids).select('connection_id', 'topic')
      : [];
    return connections.map((c) => ({
      ...c,
      subscribed_topics: subscriptions.filter((s) => s.connection_id === c.id).map((s) => s.topic),
    }));
  }
  private async withToken(
    scope: ShopifyScope,
    id: unknown,
    work: (trx: Knex.Transaction, connection: any, token: string) => Promise<any>,
  ) {
    const initial = await this.owned(scope, id);
    return this.database.transaction(async (trx) => {
      await this.lock(trx, initial.shop_domain);
      let connection = await this.owned(scope, id, trx);
      if (connection.status !== 'connected' || !connection.access_token_ciphertext)
        fail(409, 'Reconnect this Shopify store first.');
      const ctx = context(connection);
      if (new Date(connection.token_expires_at).getTime() <= Date.now() + 60000) {
        const app = await this.appCredentials(scope, connection, trx);
        let values;
        if (app) values = clientTokenFields(await this.shopify.clientCredentials(connection.shop_domain, app.clientId, app.clientSecret), ctx);
        else {
          if (!connection.refresh_token_ciphertext || new Date(connection.refresh_expires_at).getTime() <= Date.now())
            fail(401, 'Shopify refresh authorization expired. Reconnect the store.');
          const tokens = await this.shopify.refresh(connection.shop_domain, decrypt(connection.refresh_token_ciphertext, ctx));
          values = tokenFields(tokens, ctx, connection.scopes);
        }
        [connection] = await trx('shopify_connections')
          .where({ id: connection.id })
          .update({ ...values, updated_at: new Date() })
          .returning('*');
      }
      return work(trx, connection, decrypt(connection.access_token_ciphertext, ctx));
    });
  }
  /** Manage app-owned subscriptions for one separate automation flow. */
  async automationWebhook(scope: ShopifyScope, id: unknown, flowId: string, topic: string, uri: string,
    mode: 'ensure' | 'inspect' | 'remove' = 'ensure') {
    owner(scope); identifier(flowId);
    const requiredScope = topic === 'customers/create' ? 'read_customers' : 'read_orders';
    if (!['orders/create', 'orders/updated', 'orders/paid', 'customers/create', 'carts/update'].includes(topic))
      fail(400, 'Unsupported Shopify automation webhook topic');
    let destination: URL, allowed: URL;
    try { destination = new URL(uri); allowed = new URL(process.env.AUTOMATION_PUBLIC_BASE_URL || new URL(process.env.SHOPIFY_REDIRECT_URI || '').origin); }
    catch { return fail(503, 'Configure the public automation API URL'); }
    const prefix = `/v1/webhook/flows/${flowId}/`;
    if (destination.protocol !== 'https:' || destination.origin !== allowed.origin || destination.username ||
        destination.password || destination.search || destination.hash ||
        !new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(destination.pathname))
      fail(400, 'Automatic Shopify webhooks require the generated public HTTPS flow URL');
    // Catch inside withToken so a provider error does not roll back an already rotated refresh token.
    const outcome = await this.withToken(scope, id, async (_tx, connection, token) => {
      try {
        if (mode !== 'remove' && !connection.scopes.includes(requiredScope))
          fail(403, `Reconnect Shopify with ${requiredScope} permission`);
        const remote = await this.shopify.subscriptions(connection.shop_domain, token);
        const owned = remote.filter(subscription => {
          try { const url = new URL(subscription.uri); return url.pathname.startsWith(prefix); } catch { return false; }
        });
        const topicKey = topic.toUpperCase().replace('/', '_');
        const matches = owned.filter(subscription => subscription.uri === uri && subscription.topic === topicKey);
        if (mode === 'remove') {
          for (const subscription of owned) await this.shopify.unsubscribe(connection.shop_domain, token, subscription.id);
          return { value: { subscribed: false, removed: owned.length, topic, webhookPath: uri } };
        }
        if (mode === 'inspect') return { value: { subscribed: matches.length > 0, topic, webhookPath: uri,
          subscription_id: matches[0]?.id || null, matching_subscriptions: matches.length } };
        const subscription = matches[0] || await this.shopify.subscribe(connection.shop_domain, token, topicKey, uri);
        if (subscription.uri !== uri || subscription.topic !== topicKey || typeof subscription.id !== 'string')
          fail(502, 'Shopify returned an unexpected webhook subscription');
        // Reconcile this flow only, including obsolete tunnel URLs/tokens and duplicate subscriptions.
        for (const previous of owned) if (previous.id !== subscription.id)
          await this.shopify.unsubscribe(connection.shop_domain, token, previous.id);
        return { value: { subscribed: true, topic, webhookPath: uri, subscription_id: subscription.id,
          reused: matches.length > 0 } };
      } catch (error) { return { error }; }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  /** Fixed read-only operations for the separate automation flow builder. */
  async automation(scope: ShopifyScope, id: unknown, key: string, input: Record<string, any>) {
    return this.withToken(scope, id, async (_tx, connection, token) => {
      const product = ['getProduct', 'listProducts'].includes(key);
      if (!['getOrder', 'listOrders', 'getProduct', 'listProducts'].includes(key)) fail(400, 'Unsupported Shopify flow action');
      if (!connection.scopes.includes(product ? 'read_products' : 'read_orders')) fail(403, `Reconnect Shopify with ${product ? 'read_products' : 'read_orders'} permission`);
      const fields = product
        ? 'id title handle status priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }'
        : 'id name createdAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } }';
      const single = key.startsWith('get'), resource = product ? 'product' : 'order';
      if (single) {
        const supplied = input[product ? 'product_id' : 'order_id'];
        if (typeof supplied !== 'string') fail(400, 'Use a Shopify GraphQL ID or numeric ID string');
        const type = product ? 'Product' : 'Order';
        const gid = /^\d+$/.test(supplied) ? `gid://shopify/${type}/${supplied}` : supplied;
        if (!new RegExp(`^gid://shopify/${type}/[0-9]+$`).test(gid)) fail(400, 'Invalid Shopify resource ID');
        const result = await this.shopify.graphql(connection.shop_domain, token, `query($id: ID!) { ${resource}(id: $id) { ${fields} } }`, { id: gid });
        return result[resource] || fail(404, 'Shopify resource not found');
      }
      const result = await this.shopify.graphql(connection.shop_domain, token,
        `query($first: Int!, $after: String, $query: String) { ${resource}s(first: $first, after: $after, query: $query) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`,
        { first: input.limit || 20, after: input.after || null, query: input.query || null });
      return result[`${resource}s`];
    });
  }
  /** Safe operator diagnostic: normal credential refresh, but no customer query or subscription changes. */
  async verifyConnection(scope: ShopifyScope, id: unknown) {
    const outcome = await this.withToken(scope, id, async (_trx, connection, token) => {
      try {
        const identity = await this.shopify.identity(connection.shop_domain, token);
        if (identity?.shop?.myshopifyDomain !== connection.shop_domain)
          fail(403, 'Shopify returned a different store identity. Reconnect the store.');
        const subscriptions = await this.shopify.subscriptions(connection.shop_domain, token);
        return {
          value: {
            store_identity_matches: true,
            granted_scopes: identity.currentAppInstallation.accessScopes.map((s: any) => s.handle),
            subscriptions: subscriptions.map((s: any) => {
              let currentDestination = false;
              try {
                const url = new URL(s.uri);
                currentDestination =
                  url.origin === configuration().origin &&
                  url.pathname.startsWith(`/v1/integrations/shopify/webhook/${connection.id}/`);
              } catch {}
              return { topic: s.topic, current_app_destination: currentDestination };
            }),
          },
        };
      } catch (error) {
        // A diagnostic failure must not roll back credentials already rotated upstream.
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async saveTriggers(scope: ShopifyScope, id: unknown, selected: unknown) {
    if (
      !Array.isArray(selected) ||
      selected.length > Object.keys(topics).length ||
      selected.some((t) => typeof t !== 'string' || !topics[t])
    )
      fail(400, 'Select supported Shopify trigger topics. Abandoned checkout is not a direct trigger in this version.');
    await this.owned(scope, id);
    const selectedTopics = selected as string[];
    // Save intent before remote calls so a failed sync is visible and retryable.
    await this.withToken(scope, id, async (trx, connection) => {
      if (selectedTopics.some((t) => !connection.scopes.includes(topics[t].scope)))
        fail(403, 'Reconnect the store with the permissions required by these triggers.');
      await trx('shopify_connections')
        .where({ id: connection.id })
        .update({ desired_topics: JSON.stringify([...new Set(selectedTopics)]), updated_at: new Date() });
    });
    return this.sync(scope, id);
  }
  async sync(scope: ShopifyScope, id: unknown) {
    owner(scope);
    const connected = await this.owned(scope, id);
    if (await this.appCredentials(scope, connected)) fail(400, 'Register this app connection through the automation flow webhook/subscribe API');
    try {
      await this.withToken(scope, id, async (trx, connection, token) => {
        const desired = [...connection.desired_topics, ...lifecycle],
          ctx = context(connection);
        const uri = `${configuration().origin}/v1/integrations/shopify/webhook/${connection.id}/${decrypt(connection.delivery_token_ciphertext, ctx)}`;
        const remote = await this.shopify.subscriptions(connection.shop_domain, token);
        const saved = await trx('shopify_subscriptions')
          .where({ connection_id: connection.id })
          .select('shopify_id', 'uri');
        const owned = remote.filter(
          (s) => s.uri === uri || saved.some((row) => row.shopify_id === s.id && row.uri === s.uri),
        );
        const topicKey = (topic: string) => topics[topic]?.key || topic.toUpperCase().replace('/', '_');
        for (const subscription of owned) {
          if (subscription.uri !== uri || !desired.some((t) => topicKey(t) === subscription.topic))
            await this.shopify.unsubscribe(connection.shop_domain, token, subscription.id);
        }
        for (const topic of desired) {
          const matches = owned.filter((s) => s.uri === uri && s.topic === topicKey(topic));
          const subscription =
            matches[0] || (await this.shopify.subscribe(connection.shop_domain, token, topicKey(topic), uri));
          for (const duplicate of matches.slice(1))
            await this.shopify.unsubscribe(connection.shop_domain, token, duplicate.id);
          const data = {
            connection_id: connection.id,
            topic,
            shopify_id: subscription.id,
            uri,
            updated_at: new Date(),
          };
          await trx('shopify_subscriptions').insert(data).onConflict(['connection_id', 'topic']).merge(data);
        }
        await trx('shopify_subscriptions')
          .where({ connection_id: connection.id })
          .whereNotIn('topic', desired)
          .delete();
        await trx('shopify_connections').where({ id: connection.id }).update({ subscription_issue: null });
      });
    } catch (error) {
      // Restrict the error update too; it must never mutate another tenant's connection.
      await this.database('shopify_connections')
        .where({ ...where(scope), id: identifier(id) })
        .update({
          subscription_issue:
            'Webhook setup failed. Check Shopify scopes, app approval and the callback host; retry Save triggers.',
        });
      throw error;
    }
    return { connections: await this.connections(scope) };
  }
  async disconnect(scope: ShopifyScope, id: unknown) {
    const connection = await this.owned(scope, id);
    if (connection.status === 'connected') {
      await this.withToken(scope, id, async (trx, c, token) => {
        const app = await this.appCredentials(scope, c, trx);
        const uri = app ? null : `${configuration().origin}/v1/integrations/shopify/webhook/${c.id}/${decrypt(c.delivery_token_ciphertext, context(c))}`;
        const remote = await this.shopify.subscriptions(c.shop_domain, token);
        const saved = await trx('shopify_subscriptions').where({ connection_id: c.id }).select('shopify_id', 'uri');
        for (const s of remote.filter(
          (s) => s.uri === uri || saved.some((row) => row.shopify_id === s.id && row.uri === s.uri),
        ))
          await this.shopify.unsubscribe(c.shop_domain, token, s.id);
        await trx('shopify_subscriptions').where({ connection_id: c.id }).delete();
        await trx('shopify_oauth_sessions')
          .where({ ...where(scope), shop_domain: c.shop_domain })
          .delete();
        await trx('shopify_connections').where({ id: c.id }).update({
          status: 'disconnected',
          access_token_ciphertext: null,
          refresh_token_ciphertext: null,
          token_expires_at: null,
          refresh_expires_at: null,
          subscription_issue: null,
          updated_at: new Date(),
        });
        await trx('shopify_whatsapp_jobs').where({ connection_id: c.id, status: 'queued' }).update({
          status: 'cancelled',
          reason: 'store_disconnected',
          payload_ciphertext: null,
          finished_at: new Date(),
        });
        if (app) await trx('shopify_app_credentials').where({ connection_id: c.id, ...where(scope) }).delete();
      });
    }
    return { disconnected: true };
  }
  async events(scope: ShopifyScope, id: unknown) {
    const connection = await this.owned(scope, id);
    const events = await this.database('shopify_events')
      .where({ connection_id: connection.id })
      .where('expires_at', '>', new Date())
      .whereNotIn('topic', compliance)
      .orderBy('received_at', 'desc')
      .limit(50)
      .select('id', 'topic', 'resource_id', 'status', 'received_at', 'event_id', 'flow_id');
    return { events };
  }
  async event(scope: ShopifyScope, id: unknown, eventId: unknown) {
    const connection = await this.owned(scope, id);
    const event = await this.database('shopify_events')
      .where({ connection_id: connection.id, id: identifier(eventId) })
      .where('expires_at', '>', new Date())
      .whereNotIn('topic', compliance)
      .first();
    if (!event) fail(404, 'Shopify event not found in your account.');
    const payload = event.payload_ciphertext
      ? minimizePayload(event.topic, JSON.parse(decrypt(event.payload_ciphertext, context(connection))))
      : null;
    await this.audit(this.database, connection.id, scope.userId, 'event.read', event.id);
    return {
      id: event.id,
      topic: event.topic,
      status: event.status,
      received_at: event.received_at,
      payload,
    };
  }
  private async audit(
    database: Knex | Knex.Transaction,
    connectionId: string,
    actor: string,
    action: string,
    target: string,
  ) {
    await database('shopify_data_access_log').insert({
      connection_id: connectionId,
      actor_id: actor,
      action,
      target_id: target,
      created_at: new Date(),
    });
  }
  async privacyRequests(scope: ShopifyScope, id: unknown) {
    const connection = await this.owned(scope, id);
    const requests = await this.database('shopify_privacy_requests')
      .where({ connection_id: connection.id })
      .orderBy('status', 'desc')
      .orderBy('due_at', 'asc')
      .limit(100)
      .select('id', 'topic', 'status', 'created_at', 'due_at', 'exported_at', 'completed_at');
    const [pending] = await this.database('shopify_privacy_requests')
      .where({ connection_id: connection.id, status: 'pending' })
      .count('* as count');
    const [overdue] = await this.database('shopify_privacy_requests')
      .where({ connection_id: connection.id, status: 'pending' })
      .where('due_at', '<', new Date())
      .count('* as count');
    return { requests, pending: Number(pending.count), overdue: Number(overdue.count) };
  }
  async privacyExport(
    scope: ShopifyScope,
    id: unknown,
    requestId: unknown,
    after?: unknown,
    section: unknown = 'events',
  ) {
    if (!['events', 'messages'].includes(section as string)) fail(400, 'Invalid export section.');
    const initial = await this.owned(scope, id);
    return this.database.transaction(async (trx) => {
      await this.lock(trx, initial.shop_domain);
      const connection = await this.owned(scope, id, trx);
      const request = await trx('shopify_privacy_requests')
        .where({
          id: identifier(requestId),
          connection_id: connection.id,
          topic: 'customers/data_request',
          status: 'pending',
        })
        .first();
      if (!request) fail(404, 'Pending Shopify data request not found in your account.');
      if (await trx('shopify_events').where({ connection_id: connection.id, payload_version: 0 }).first())
        fail(409, 'Existing Shopify events are being prepared for privacy requests. Try again after maintenance runs.');
      if (
        await trx('shopify_privacy_requests')
          .where({ connection_id: connection.id, topic: 'customers/redact', status: 'pending' })
          .first()
      )
        fail(409, 'A customer erasure is pending. Export after privacy maintenance completes.');
      if (section === 'messages') {
        let jobsQuery = matching(
          trx('shopify_whatsapp_jobs').where({ connection_id: connection.id }),
          request.subject_hashes,
        );
        if (after !== undefined && after !== '') jobsQuery = jobsQuery.where('id', '>', identifier(after));
        const rows = await jobsQuery.orderBy('id', 'asc').limit(201),
          page = rows.slice(0, 200);
        const history = page.length
          ? await trx('messages')
              .whereIn(
                'shopify_job_id',
                page.map((j: any) => j.id),
              )
              .select('shopify_job_id', 'content', 'to_phone', 'status', 'wamid', 'created_at')
          : [];
        const messages = page.map((j: any) => ({
          id: j.id,
          topic: j.topic,
          status: j.status,
          reason: j.reason,
          created_at: j.created_at,
          details: j.payload_ciphertext ? JSON.parse(decrypt(j.payload_ciphertext, context(connection))) : null,
          outbound_message: history.find((m: any) => m.shopify_job_id === j.id) || null,
        }));
        const next = rows.length > 200 ? page[page.length - 1].id : null;
        await this.audit(trx, connection.id, scope.userId, 'privacy.export', request.id);
        if (!next) await trx('shopify_privacy_requests').where({ id: request.id }).update({ exported_at: new Date() });
        return {
          request_id: request.id,
          shop_domain: connection.shop_domain,
          request: JSON.parse(decrypt(request.payload_ciphertext, context(connection))),
          events: [],
          messages,
          next_cursor: next,
          next_section: null,
        };
      }
      let query = matching(trx('shopify_events').where({ connection_id: connection.id }), request.subject_hashes)
        .whereNotIn('topic', [...lifecycle, ...compliance])
        .whereNot('status', 'redacted');
      if (after !== undefined && after !== '') query = query.where('id', '>', identifier(after));
      const rows = await query.orderBy('id', 'asc').limit(201);
      const page = rows.slice(0, 200);
      const events = page.map((e: any) => ({
        id: e.id,
        topic: e.topic,
        received_at: e.received_at,
        payload: e.payload_ciphertext
          ? minimizePayload(e.topic, JSON.parse(decrypt(e.payload_ciphertext, context(connection))))
          : null,
      }));
      const next = rows.length > 200 ? page[page.length - 1].id : null;
      const hasMessages =
        !next &&
        (await matching(
          trx('shopify_whatsapp_jobs').where({ connection_id: connection.id }),
          request.subject_hashes,
        ).first());
      await this.audit(trx, connection.id, scope.userId, 'privacy.export', request.id);
      if (!next && !hasMessages)
        await trx('shopify_privacy_requests').where({ id: request.id }).update({ exported_at: new Date() });
      return {
        request_id: request.id,
        shop_domain: connection.shop_domain,
        request: JSON.parse(decrypt(request.payload_ciphertext, context(connection))),
        events,
        next_cursor: next,
        next_section: hasMessages ? 'messages' : null,
      };
    });
  }
  async completePrivacyRequest(scope: ShopifyScope, id: unknown, requestId: unknown, delivered: unknown) {
    if (delivered !== true) fail(400, 'Confirm that you delivered the complete export to the merchant.');
    const initial = await this.owned(scope, id);
    return this.database.transaction(async (trx) => {
      await this.lock(trx, initial.shop_domain);
      const connection = await this.owned(scope, id, trx);
      const request = await trx('shopify_privacy_requests')
        .where({
          id: identifier(requestId),
          connection_id: connection.id,
          topic: 'customers/data_request',
          status: 'pending',
        })
        .first();
      if (!request) fail(404, 'Pending Shopify data request not found in your account.');
      if (!request.exported_at) fail(409, 'Download all export pages before completing this request.');
      await trx('shopify_privacy_requests').where({ id: request.id }).update({
        status: 'completed',
        completed_at: new Date(),
        completed_by: scope.userId,
        payload_ciphertext: null,
        subject_hashes: '[]',
      });
      await this.audit(trx, connection.id, scope.userId, 'privacy.complete', request.id);
      return { completed: true };
    });
  }

  // Bounded work per store; the scheduler repeats until legacy payloads are scrubbed.
  async maintainPrivacy() {
    const stats = { scrubbed: 0, redacted: 0, expired: 0, pending: 0, overdue: 0, failed: 0 };
    let cursor: string | undefined;
    for (;;) {
      let query = this.database('shopify_connections').orderBy('id', 'asc').limit(25);
      if (cursor) query = query.where('id', '>', cursor);
      const stores = await query;
      if (!stores.length) break;
      for (const initial of stores) {
        const before = { ...stats };
        try {
          await this.database.transaction(async (trx) => {
            const lock = await trx.raw('select pg_try_advisory_xact_lock(hashtext(?)) as locked', [
              `shopify:${initial.shop_domain}`,
            ]);
            if (lock.rows?.[0]?.locked === false) return;
            const connection = await trx('shopify_connections').where({ id: initial.id }).first();
            if (!connection) return;
            const ctx = context(connection),
              now = new Date();
            const legacy = await trx('shopify_events')
              .where({ connection_id: connection.id, payload_version: 0 })
              .limit(500);
            for (const row of legacy) {
              const raw = row.payload_ciphertext ? JSON.parse(decrypt(row.payload_ciphertext, ctx)) : {};
              const minimized = minimizePayload(row.topic, raw),
                hashes = subjectHashes(row.topic, raw, ctx);
              if (compliance.includes(row.topic)) {
                if (
                  !(await trx('shopify_privacy_requests')
                    .where({ connection_id: connection.id, delivery_id: row.delivery_id })
                    .first())
                )
                  await trx('shopify_privacy_requests').insert({
                    connection_id: connection.id,
                    delivery_id: row.delivery_id,
                    topic: row.topic,
                    status: row.status === 'redacted' ? 'completed' : 'pending',
                    payload_ciphertext: row.status === 'redacted' ? null : encrypt(JSON.stringify(minimized), ctx),
                    subject_hashes: JSON.stringify(hashes),
                    created_at: row.received_at,
                    due_at: expiresAt(new Date(row.received_at), 30),
                    completed_at: row.status === 'redacted' ? now : null,
                  });
                await trx('shopify_events').where({ id: row.id }).delete();
              } else
                await trx('shopify_events')
                  .where({ id: row.id })
                  .update({
                    payload_version: 1,
                    payload_ciphertext: row.payload_ciphertext ? encrypt(JSON.stringify(minimized), ctx) : null,
                    subject_hashes: JSON.stringify(row.status === 'redacted' ? [] : hashes),
                    expires_at: expiresAt(new Date(row.received_at)),
                  });
              stats.scrubbed++;
            }
            const remaining = await trx('shopify_events')
              .where({ connection_id: connection.id, payload_version: 0 })
              .first();
            if (!remaining) {
              const redactions = await trx('shopify_privacy_requests')
                .where({ connection_id: connection.id, topic: 'customers/redact', status: 'pending' })
                .limit(50);
              for (const request of redactions) {
                const expiry = expiresAt(now, 30);
                for (let offset = 0; offset < request.subject_hashes.length; offset += 500) {
                  const records = request.subject_hashes.slice(offset, offset + 500).map((h: string) => ({
                    connection_id: connection.id,
                    subject_hash: h,
                    expires_at: expiry,
                  }));
                  await trx('shopify_redactions')
                    .insert(records)
                    .onConflict(['connection_id', 'subject_hash'])
                    .merge({ expires_at: expiry });
                }
                // Erase contents but retain the delivery receipt until its retention deadline for deduplication.
                const jobs = await matching(
                  trx('shopify_whatsapp_jobs').where({ connection_id: connection.id }),
                  request.subject_hashes,
                ).select('id');
                for (let offset = 0; offset < jobs.length; offset += 500)
                  await trx('messages')
                    .whereIn(
                      'shopify_job_id',
                      jobs.slice(offset, offset + 500).map((j: any) => j.id),
                    )
                    .delete();
                await matching(
                  trx('shopify_whatsapp_jobs').where({ connection_id: connection.id }),
                  request.subject_hashes,
                ).update({
                  status: 'cancelled',
                  reason: 'customer_erased',
                  payload_ciphertext: null,
                  resource_id: null,
                  subject_hashes: '[]',
                  finished_at: now,
                });
                await matching(
                  trx('shopify_events').where({ connection_id: connection.id }),
                  request.subject_hashes,
                ).update({
                  payload_ciphertext: null,
                  customer_id: null,
                  resource_id: null,
                  subject_hashes: '[]',
                  status: 'redacted',
                });
                // Automation receipts and their dependent run results share the same subject hashes.
                if (trx.schema?.hasTable && await trx.schema.hasTable('automation_events'))
                  await matching(trx('automation_events').where({ app_key: 'shopify', connection_id: connection.id }), request.subject_hashes).delete();
                await trx('shopify_privacy_requests')
                  .where({ id: request.id })
                  .update({ status: 'completed', payload_ciphertext: null, subject_hashes: '[]', completed_at: now });
                stats.redacted++;
              }
            }
            const [pending] = await trx('shopify_privacy_requests')
              .where({ connection_id: connection.id, status: 'pending' })
              .count('* as count');
            const [overdue] = await trx('shopify_privacy_requests')
              .where({ connection_id: connection.id, status: 'pending' })
              .where('due_at', '<', now)
              .count('* as count');
            stats.pending += Number(pending.count);
            stats.overdue += Number(overdue.count);
            // Hold retained data while a subject request is outstanding. Show overdue requests to the owner.
            if (!Number(pending.count)) {
              const expiredJobs = await trx('shopify_whatsapp_jobs')
                .where({ connection_id: connection.id })
                .where('expires_at', '<', now)
                .select('id')
                .limit(1000);
              if (expiredJobs.length)
                await trx('shopify_whatsapp_jobs')
                  .whereIn(
                    'id',
                    expiredJobs.map((j: any) => j.id),
                  )
                  .delete();
              const expired = await trx('shopify_events')
                .where({ connection_id: connection.id })
                .where('expires_at', '<', now)
                .select('id')
                .limit(1000);
              if (expired.length)
                await trx('shopify_events')
                  .whereIn(
                    'id',
                    expired.map((e) => e.id),
                  )
                  .delete();
              stats.expired += expired.length;
            }
            await trx('shopify_privacy_requests')
              .where({ connection_id: connection.id, status: 'completed' })
              .where('completed_at', '<', new Date(now.getTime() - 30 * 86400000))
              .delete();
            await trx('shopify_redactions')
              .where({ connection_id: connection.id })
              .where('expires_at', '<', now)
              .delete();
            await trx('shopify_data_access_log')
              .where({ connection_id: connection.id })
              .where('created_at', '<', new Date(now.getTime() - 90 * 86400000))
              .delete();
            if (
              connection.status === 'uninstalled' &&
              new Date(connection.updated_at).getTime() < now.getTime() - 48 * 3600000
            ) {
              await trx('shopify_oauth_sessions').where({ shop_domain: connection.shop_domain }).delete();
              await trx('shopify_connections').where({ id: connection.id }).delete();
            }
          });
        } catch {
          // One store with a damaged payload must not prevent other merchants' privacy work.
          Object.assign(stats, before);
          stats.failed++;
        }
      }
      cursor = stores[stores.length - 1].id;
    }
    await this.database('shopify_oauth_sessions').where('expires_at', '<', new Date()).delete();
    await this.database('shopify_flow_webhooks').where('expires_at', '<=', new Date()).update({
      enabled: false,
      signing_secret_ciphertext: null,
      token_ciphertext: null,
    });
    return stats;
  }
  async receive(
    raw: Buffer | undefined,
    signature: unknown,
    headers: Record<string, any>,
    id?: unknown,
    deliveryToken?: unknown,
  ) {
    const flowBinding = this.flowReceiver ? await this.flowBinding() : null;
    verifyWebhook(
      raw,
      signature,
      flowBinding
        ? decrypt(
            flowBinding.signing_secret_ciphertext,
            `shopify-flow:${flowBinding.flow_id}:${flowBinding.connection_id}`,
          )
        : undefined,
    );
    let payload: any;
    try {
      payload = JSON.parse(raw!.toString('utf8'));
    } catch {
      return fail(400, 'Invalid Shopify JSON body.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'Invalid Shopify event body.');
    const shop = shopDomain(headers['x-shopify-shop-domain']),
      topic = headers['x-shopify-topic'];
    const deliveryId = headers['x-shopify-webhook-id'],
      eventId = headers['x-shopify-event-id'];
    if (
      typeof topic !== 'string' ||
      !(this.flowReceiver ? flowTestTopics : [...Object.keys(topics), ...lifecycle, ...compliance]).includes(topic) ||
      typeof deliveryId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(deliveryId) ||
      (eventId !== undefined && (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(eventId)))
    )
      fail(400, 'Unsupported Shopify event or missing delivery ID.');
    return this.database.transaction(async (trx) => {
      // Do not wait behind an OAuth exchange or subscription request: Shopify's
      // delivery deadline is five seconds. A busy store gets a retryable 503.
      const lock = await trx.raw('select pg_try_advisory_xact_lock(hashtext(?)) as locked', [`shopify:${shop}`]);
      if (lock.rows?.[0]?.locked === false) fail(503, 'Shopify store setup is busy. Retry this delivery.');
      const connection = await trx('shopify_connections').where({ shop_domain: shop }).first();
      if (!connection) {
        if (this.flowReceiver) fail(401, 'Shopify event does not match this test store.');
        return { accepted: true, ignored: true };
      }
      const ctx = context(connection);
      if (this.flowReceiver) {
        const binding = await this.flowBinding(trx);
        if (binding.connection_id !== connection.id || connection.status !== 'connected')
          fail(401, 'Shopify event does not match this test flow and store.');
        if (binding.topic !== '*' && binding.topic !== topic)
          fail(400, `This test flow expects ${binding.topic}. Select that event or configure an all-events test flow.`);
        const bot = await trx('chat_bot')
          .where({
            id: binding.flow_id,
            user_id: connection.owner_id,
            company_id: connection.company_id,
            is_active: true,
          })
          .first();
        const user = await trx('users')
          .where({ id: connection.owner_id, company_id: connection.company_id, status: 'active' })
          .whereNull('deleted_at')
          .first();
        const company = await trx('companies')
          .where({ id: connection.company_id, status: 'active' })
          .whereNull('deleted_at')
          .first();
        if (!bot || !user || !company) fail(401, 'Shopify test flow owner is not active.');
        verifyWebhook(
          raw,
          signature,
          decrypt(binding.signing_secret_ciphertext, `shopify-flow:${binding.flow_id}:${binding.connection_id}`),
        );
      } else if (id !== undefined) {
        if (
          identifier(id) !== connection.id ||
          !nonce(deliveryToken) ||
          !equalSecret(decrypt(connection.delivery_token_ciphertext, ctx), deliveryToken as string)
        )
          fail(401, 'Invalid Shopify delivery destination.');
      } else {
        // The shared endpoint is reserved for mandatory privacy requests. Store subscriptions use a bound URL.
        if (!compliance.includes(topic)) fail(400, "Use this store subscription's registered webhook destination.");
        if (payload.shop_domain !== shop || String(payload.shop_id) !== connection.shop_id.split('/').pop())
          fail(401, 'Shopify privacy request does not match the connected store.');
      }
      const existing = await trx('shopify_events')
        .where({ connection_id: connection.id, delivery_id: deliveryId })
        .first();
      if (existing) return { accepted: true, duplicate: true };
      if (
        await trx('shopify_privacy_requests').where({ connection_id: connection.id, delivery_id: deliveryId }).first()
      )
        return { accepted: true, duplicate: true };
      if (topic === 'shop/redact') {
        if (trx.schema?.hasTable && await trx.schema.hasTable('automation_events'))
          await trx('automation_events').where({ app_key: 'shopify', connection_id: connection.id }).delete();
        await trx('shopify_oauth_sessions').where({ shop_domain: shop }).delete();
        await trx('shopify_connections').where({ id: connection.id }).delete();
        return { accepted: true, redacted: true };
      }
      if (
        !compliance.includes(topic) &&
        !lifecycle.includes(topic) &&
        (connection.status !== 'connected' || (!this.flowReceiver && !connection.desired_topics.includes(topic)))
      )
        return { accepted: true, ignored: true };
      const privacy = compliance.includes(topic);
      const hashes = subjectHashes(topic, payload, ctx);
      if (privacy) {
        if (!hashes.length) fail(400, 'Privacy request must identify a customer or requested orders.');
        const [request] = await trx('shopify_privacy_requests')
          .insert({
            connection_id: connection.id,
            delivery_id: deliveryId,
            topic,
            status: 'pending',
            subject_hashes: JSON.stringify(hashes),
            payload_ciphertext: encrypt(JSON.stringify(minimizePayload(topic, payload)), ctx),
            created_at: new Date(),
            due_at: expiresAt(new Date(), 30),
          })
          .returning('id');
        return { accepted: true, request_id: request.id };
      }
      // Suppress pending erasures without a per-subject write loop in the webhook's five-second budget.
      if (
        hashes.length &&
        (await matching(
          trx('shopify_privacy_requests').where({
            connection_id: connection.id,
            topic: 'customers/redact',
            status: 'pending',
          }),
          hashes,
        ).first())
      )
        return { accepted: true, ignored: true };
      if (
        hashes.length &&
        (await trx('shopify_redactions')
          .where({ connection_id: connection.id })
          .whereIn('subject_hash', hashes)
          .where('expires_at', '>', new Date())
          .first())
      )
        return { accepted: true, ignored: true };
      const customerId = topic === 'customers/create' ? payload.id : payload.customer?.id;
      const [event] = await trx('shopify_events')
        .insert({
          connection_id: connection.id,
          delivery_id: deliveryId,
          event_id: eventId || null,
          topic,
          resource_id: scalarId(payload.id),
          customer_id: scalarId(customerId),
          payload_ciphertext: encrypt(JSON.stringify(minimizePayload(topic, payload)), ctx),
          subject_hashes: JSON.stringify(hashes),
          payload_version: 1,
          received_at: new Date(),
          expires_at: expiresAt(),
          ...(this.flowReceiver ? { flow_id: this.flowReceiver.flowId } : {}),
          status: 'received',
        })
        .returning('id');
      // Manual flow test deliveries are receipt-only and must never activate real message rules.
      if (!this.flowReceiver) await enqueueShopifyMessage(trx, connection, topic, payload, event.id, hashes);
      if (topic === 'app/uninstalled') {
        // Do not let a delayed uninstall delivery clear credentials acquired by a later reconnect.
        const triggeredAt = Date.parse(headers['x-shopify-triggered-at'] || '');
        if (!Number.isFinite(triggeredAt)) fail(400, 'Missing Shopify lifecycle event timestamp.');
        if (triggeredAt >= new Date(connection.connected_at).getTime()) {
          await trx('shopify_connections').where({ id: connection.id }).update({
            status: 'uninstalled',
            access_token_ciphertext: null,
            refresh_token_ciphertext: null,
            token_expires_at: null,
            refresh_expires_at: null,
            updated_at: new Date(),
          });
          await trx('shopify_subscriptions').where({ connection_id: connection.id }).delete();
          await trx('shopify_whatsapp_jobs').where({ connection_id: connection.id, status: 'queued' }).update({
            status: 'cancelled',
            reason: 'store_uninstalled',
            payload_ciphertext: null,
            finished_at: new Date(),
          });
        }
      }
      if (topic === 'app/scopes_update' && Array.isArray(payload.current)) {
        if (payload.current.some((s: any) => typeof s !== 'string')) fail(400, 'Invalid Shopify scopes event.');
        const triggeredAt = Date.parse(headers['x-shopify-triggered-at'] || '');
        if (!Number.isFinite(triggeredAt)) fail(400, 'Missing Shopify lifecycle event timestamp.');
        if (triggeredAt >= new Date(connection.connected_at).getTime())
          await trx('shopify_connections')
            .where({ id: connection.id })
            .update({ scopes: JSON.stringify(payload.current) });
      }
      return { accepted: true, event_id: event.id };
    });
  }
}
export default new ShopifyService();
