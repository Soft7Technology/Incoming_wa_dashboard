import db from '@surefy/database';
import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { ShopifyService } from './shopify.service';
import {
  ShopifyScope,
  configuration,
  decrypt,
  encrypt,
  fail,
  hash,
  identifier,
  owner,
  random,
  flowTestTopics,
} from '../utils/shopify';

type Reserve = (userId: string, action: (trx: Knex.Transaction) => Promise<any>) => Promise<any>;
const context = (flowId: string, connectionId: string) => `shopify-flow:${flowId}:${connectionId}`;

/** A manual Shopify Admin receiver for testing. It records receipts, never executes chatbot/message nodes. */
export class ShopifyFlowWebhookService {
  constructor(
    private database: Knex = db,
    private reserve: Reserve = async (userId, action) =>
      (await import('./planUsage.service')).default.run(userId, 'Chatbot', action),
  ) {}

  async create(scope: ShopifyScope, connectionId: unknown, body: any) {
    owner(scope);
    const id = identifier(connectionId),
      topic = body?.topic || 'orders/create';
    if (typeof topic !== 'string' || (topic !== '*' && !flowTestTopics.includes(topic)))
      fail(400, 'Select a supported order, customer, cart or checkout event, or * for all supported test events.');
    if (typeof body?.signing_secret !== 'string' || !/^[a-f0-9]{64}$/i.test(body.signing_secret))
      fail(400, 'Use the store webhook signing secret shown in Shopify Settings > Notifications > Webhooks.');
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : 'Shopify order webhook test';
    if (!name) fail(400, 'Enter a name for the test flow.');
    return this.reserve(scope.ownerId, async (trx) => {
      const connection = await trx('shopify_connections')
        .where({ id, owner_id: scope.ownerId, company_id: scope.companyId, status: 'connected' })
        .first();
      if (!connection) fail(404, 'Connected Shopify store not found in your account.');
      const flowId = randomUUID(),
        token = random(),
        ctx = context(flowId, id);
      const expires = new Date(Date.now() + 7 * 86400000);
      await trx('chat_bot').insert({
        id: flowId,
        user_id: scope.ownerId,
        company_id: scope.companyId,
        name,
        description:
          'Receive-only Shopify webhook test. Records minimized events; no WhatsApp sends or chatbot execution.',
        status: 'draft',
        published: false,
        is_active: true,
        flow_type: 'shopify_webhook_test',
      });
      const triggerId = randomUUID(),
        receiptId = randomUUID();
      await trx('chat_bot_node').insert([
        {
          id: triggerId,
          chatBotId: flowId,
          user_id: scope.ownerId,
          type: 'trigger',
          position: JSON.stringify({ x: 100, y: 120 }),
          data: JSON.stringify({
            key: '@shopify/webhook',
            label: 'Shopify test webhook',
            attributes: { topic, mode: 'receive_only' },
          }),
        },
        {
          id: receiptId,
          chatBotId: flowId,
          user_id: scope.ownerId,
          type: 'action',
          position: JSON.stringify({ x: 440, y: 120 }),
          data: JSON.stringify({
            key: '@shopify/event-inbox',
            label: 'Record test receipt',
            attributes: { mode: 'receive_only' },
          }),
        },
      ]);
      await trx('chat_bot_edge').insert({
        id: randomUUID(),
        chatBotId: flowId,
        user_id: scope.ownerId,
        source: triggerId,
        target: receiptId,
        label: 'Receive event',
      });
      await trx('shopify_flow_webhooks').insert({
        flow_id: flowId,
        connection_id: id,
        topic,
        token_hash: hash(token),
        token_ciphertext: encrypt(token, ctx),
        signing_secret_ciphertext: encrypt(body.signing_secret, ctx),
        enabled: true,
        expires_at: expires,
      });
      return {
        flow_id: flowId,
        name,
        topic,
        mode: 'receive_only',
        expires_at: expires,
        webhook_url: `${configuration().origin}/v1/integrations/shopify/webhook/flows/${flowId}/${token}`,
      };
    });
  }

  async receive(
    flowId: string,
    token: string,
    raw: Buffer | undefined,
    signature: unknown,
    headers: Record<string, any>,
  ) {
    return new ShopifyService(this.database, undefined, { flowId, token }).receive(raw, signature, headers);
  }

  async status(flowId: string, token: string) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'Invalid Shopify test URL.');
    const binding = await this.database('shopify_flow_webhooks')
      .where({ flow_id: identifier(flowId), token_hash: hash(token), enabled: true })
      .where('expires_at', '>', new Date())
      .first();
    if (!binding) fail(401, 'Shopify test URL is disabled, invalid or expired.');
    const connection = await this.database('shopify_connections')
      .where({ id: binding.connection_id, status: 'connected' })
      .first();
    if (!connection) fail(401, 'The Shopify store is disconnected.');
    const bot = await this.database('chat_bot')
      .where({ id: flowId, user_id: connection.owner_id, company_id: connection.company_id, is_active: true })
      .first();
    const user = await this.database('users')
      .where({ id: connection.owner_id, status: 'active', company_id: connection.company_id })
      .whereNull('deleted_at')
      .first();
    const company = await this.database('companies')
      .where({ id: connection.company_id, status: 'active' })
      .whereNull('deleted_at')
      .first();
    if (!bot || !user || !company) fail(401, 'The Shopify test flow owner is not active.');
    const query = () =>
      this.database('shopify_events')
        .where({ connection_id: connection.id, flow_id: flowId })
        .where('expires_at', '>', new Date());
    const count = await query().count('* as total').first();
    const latest = await query().orderBy('received_at', 'desc').first('received_at', 'topic');
    return {
      flow_id: flowId,
      mode: 'receive_only',
      expected_topic: binding.topic,
      accepted_topics: binding.topic === '*' ? flowTestTopics : [binding.topic],
      received: Number(count?.total ?? 0),
      last_received_at: latest?.received_at || null,
      last_received_topic: latest?.topic || null,
      expires_at: binding.expires_at,
    };
  }

  async settings(scope: ShopifyScope, connectionId: unknown, flowId: unknown) {
    owner(scope);
    const connection = await this.database('shopify_connections')
      .where({ id: identifier(connectionId), owner_id: scope.ownerId, company_id: scope.companyId })
      .first();
    if (!connection) fail(404, 'Shopify store not found in your account.');
    const binding = await this.database('shopify_flow_webhooks')
      .where({ flow_id: identifier(flowId), connection_id: connection.id, enabled: true })
      .where('expires_at', '>', new Date())
      .first();
    if (!binding?.token_ciphertext) fail(404, 'Active test flow not found in your account.');
    const token = decrypt(binding.token_ciphertext, context(binding.flow_id, connection.id));
    return {
      flow_id: binding.flow_id,
      topic: binding.topic,
      expires_at: binding.expires_at,
      webhook_url: `${configuration().origin}/v1/integrations/shopify/webhook/flows/${binding.flow_id}/${token}`,
    };
  }
}

export default new ShopifyFlowWebhookService();
