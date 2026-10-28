import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import db from '@surefy/database';
import { subjectHashes } from '../utils/shopify';
import { FlowScope, action, actions, decrypt, encrypt, fail, hash, object, publicOrigin, randomToken, shopifyContact, text, triggers, uuid, validateParameters, verifySignature } from '../utils/automationFlow';
import type { ShopifyService } from './shopify.service';

type Connection = Knex | Knex.Transaction;
const where = (scope: FlowScope) => ({ user_id: scope.userId!, company_id: scope.companyId! });
const credentialContext = (row: any) => `connection:${row.company_id}:${row.user_id}:${row.id}`;
const hookContext = (id: string) => `webhook:${id}`;

export class AutomationFlowService {
  constructor(readonly database: Knex = db, private readonly webhookProvider?: Pick<ShopifyService, 'automationWebhook' | 'automationSigningSecret' | 'connectClientCredentials'>) {}

  private async shopifyProvider() {
    return this.webhookProvider || new (await import('./shopify.service')).ShopifyService(this.database);
  }

  async actor(scope: FlowScope, database: Connection = this.database) {
    if (!scope.userId || !scope.companyId) fail(403, 'User and company context are required');
    const user = await database('users').where({ id: scope.userId, company_id: scope.companyId, status: 'active' }).whereNull('deleted_at').first('id', 'role');
    if (!user || !['user', 'admin', 'company'].includes(user.role)) fail(403, 'Only active account owners can manage automation flows');
    if (!await database('companies').where({ id: scope.companyId, status: 'active' }).whereNull('deleted_at').first('id')) fail(403, 'The company is inactive');
    return user;
  }
  private async owned(scope: FlowScope, id: unknown, database: Connection = this.database, lock = false) {
    await this.actor(scope, database);
    const query = database('automation_flows').where({ ...where(scope), id: uuid(id, 'flowId') }).whereNull('deleted_at');
    if (lock) query.forUpdate();
    return await query.first() || fail(404, 'Flow not found in your account');
  }
  private url(flow: any) {
    return `${publicOrigin()}/v1/webhook/flows/${flow.id}/${decrypt(flow.webhook_token_ciphertext, hookContext(flow.id))}`;
  }
  private format(flow: any, withSteps = true) {
    const result: any = { _id: flow.id, id: flow.id, user_id: flow.user_id, company_id: flow.company_id, name: flow.name, status: flow.status, revision: flow.revision, createdAt: flow.created_at, updatedAt: flow.updated_at };
    if (withSteps) {
      result.webhookPath = this.url(flow);
      result.webhookConfigured = !!flow.webhook_secret_ciphertext;
      result.steps = flow.steps.map((step: any) => ({ ...step, flowId: flow.id, user_id: flow.user_id, company_id: flow.company_id, webhookPath: step.type === 'trigger' ? result.webhookPath : null }));
    }
    return result;
  }
  private steps(input: any[], prior: any[] = []) {
    if (!Array.isArray(input) || input.length > 20) fail(400, 'A draft flow may have 0-20 ordered steps');
    const ids = new Set<string>(), now = new Date().toISOString();
    const normalized = input.map((raw, index) => {
      const value = object(raw), id = value._id === undefined ? randomUUID() : uuid(value._id, 'stepId');
      if (ids.has(id)) fail(400, 'Step IDs must be unique'); ids.add(id);
      if (!['trigger', 'action'].includes(value.type) || (value.type === 'trigger' && index !== 0)) fail(400, 'A trigger must be the first and only trigger; all other steps must be actions');
      const appKey = value.appKey ?? null, key = value.key ?? null, parameters = value.parameters === undefined ? {} : object(value.parameters);
      if (Buffer.byteLength(JSON.stringify(parameters)) > 128 * 1024) fail(413, 'Step parameters exceed 128 KB');
      if (appKey !== null && !['shopify', 'razorpay', 'google-sheets'].includes(appKey)) fail(400, 'Unsupported integration appKey');
      if (key !== null && typeof key !== 'string') fail(400, 'key must be a string or null');
      const connectionId = value.connectionId == null ? null : uuid(value.connectionId, 'connectionId');
      let definition: any, complete = !!(appKey && key && connectionId);
      if (appKey && key) {
        definition = value.type === 'trigger' ? triggers.find(t => t.appKey === appKey && t.key === key) : action(appKey, key);
        if (!definition) fail(400, 'Select a supported trigger');
        if (value.type === 'trigger' && Object.keys(parameters).length) fail(400, 'This trigger does not accept parameters');
        if (value.type === 'action') try { validateParameters(definition, parameters, true); } catch (error: any) { if (error.statusCode !== 400) throw error; complete = false; }
      }
      const previous = prior.find(step => step._id === id);
      return { _id: id, type: value.type, appKey, key, connectionId, name: value.name == null ? definition?.name || null : text(value.name, 'step name', 120), parameters, nextStepId: null as string | null, status: complete ? 'complete' : 'incomplete', deletedAt: null, createdAt: previous?.createdAt || now, updatedAt: now };
    });
    normalized.forEach((step, index) => { step.nextStepId = normalized[index + 1]?._id || null; });
    return normalized;
  }
  private editable(flow: any, revision: unknown) {
    if (flow.status === 'active') fail(409, 'Deactivate the flow before editing its configuration');
    if (revision !== undefined && revision !== flow.revision) fail(409, 'Flow changed; reload the latest revision before saving');
  }
  async catalog(scope: FlowScope) {
    await this.actor(scope);
    return ['shopify', 'google-sheets', 'razorpay'].map(appKey => ({ appKey, triggers: triggers.filter(t => t.appKey === appKey), actions: actions.filter(a => a.appKey === appKey), connection_api: appKey === 'shopify' ? '/v1/admin/shopify/oauth/start' : appKey === 'google-sheets' ? '/v1/admin/google-sheets/oauth/start' : '/v1/admin/flows/connections', ...(appKey === 'shopify' ? { credential_connection_api: '/v1/admin/flows/connections' } : {}), automatic_webhook_setup: appKey === 'shopify' }));
  }
  async create(scope: FlowScope, input: unknown) {
    const body = object(input); await this.actor(scope);
    const id = randomUUID(), token = randomToken(); publicOrigin();
    const [row] = await this.database('automation_flows').insert({ id, ...where(scope), name: text(body.name, 'name', 120), steps: JSON.stringify([]), webhook_token_hash: hash(token), webhook_token_ciphertext: encrypt(token, hookContext(id)) }).returning('*');
    return this.format(row);
  }
  async list(scope: FlowScope, query: Record<string, any> = {}) {
    await this.actor(scope);
    const page = query.page === undefined ? 1 : Number(query.page), limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'Invalid page or limit (maximum 100)');
    const base = this.database('automation_flows').where(where(scope)).whereNull('deleted_at');
    if (query.status !== undefined) { if (!['draft', 'active', 'inactive'].includes(query.status)) fail(400, 'Invalid flow status'); base.where({ status: query.status }); }
    if (query.search !== undefined) base.whereILike('name', `%${text(query.search, 'search', 120).replace(/[\\%_]/g, '\\$&')}%`);
    const [count, rows, counts] = await Promise.all([base.clone().count('* as n').first(), base.clone().orderBy('created_at', 'desc').orderBy('id').limit(limit).offset((page - 1) * limit), this.database('automation_flows').where(where(scope)).whereNull('deleted_at').select('status').count('* as n').groupBy('status')]);
    const statusCounts: Record<string, number> = { all: 0, active: 0, inactive: 0, draft: 0 };
    for (const row of counts) { statusCounts[String(row.status)] = Number(row.n); statusCounts.all += Number(row.n); }
    return { items: rows.map(row => this.format(row, false)), pagination: { page, limit, total: Number(count?.n || 0) }, counts: statusCounts };
  }
  async get(scope: FlowScope, id: unknown) { return this.format(await this.owned(scope, id)); }
  async update(scope: FlowScope, id: unknown, input: unknown) {
    const body = object(input);
    return this.database.transaction(async tx => {
      const flow = await this.owned(scope, id, tx, true);
      if (body.revision !== undefined && body.revision !== flow.revision) fail(409, 'Flow changed; reload before saving');
      const [row] = await tx('automation_flows').where({ id: flow.id }).update({ name: text(body.name, 'name', 120), revision: flow.revision + 1, updated_at: tx.fn.now() }).returning('*');
      return this.format(row);
    });
  }
  async saveSteps(scope: FlowScope, id: unknown, input: unknown, stepId?: unknown, append = false) {
    const body = object(input);
    return this.database.transaction(async tx => {
      const flow = await this.owned(scope, id, tx, true); this.editable(flow, body.revision);
      let values = body.steps;
      if (append) {
        const type = body.type ?? (flow.steps.length ? 'action' : 'trigger');
        if (!['trigger', 'action'].includes(type)) fail(400, 'Step type must be trigger or action');
        if (type === 'trigger' && flow.steps.some((step: any) => step.type === 'trigger')) fail(409, 'This flow already has a trigger');
        const step = { ...body, _id: randomUUID(), type };
        values = type === 'trigger' ? [step, ...flow.steps] : [...flow.steps, step];
      }
      if (stepId !== undefined) {
        const selected = uuid(stepId, 'stepId');
        if (!flow.steps.some((step: any) => step._id === selected)) fail(404, 'Step not found in this flow');
        values = flow.steps.map((step: any) => step._id === selected ? { ...step, ...body, _id: selected, type: step.type } : step);
      }
      const steps = this.steps(values, flow.steps), old = flow.steps.find((step: any) => step.type === 'trigger'), current = steps.find(step => step.type === 'trigger');
      const triggerChanged = old?._id !== current?._id || old?.appKey !== current?.appKey || old?.key !== current?.key || old?.connectionId !== current?.connectionId;
      const [row] = await tx('automation_flows').where({ id: flow.id }).update({ steps: JSON.stringify(steps), revision: flow.revision + 1, updated_at: tx.fn.now(), ...(triggerChanged ? { webhook_secret_ciphertext: null } : {}) }).returning('*');
      return this.format(row);
    });
  }
  async removeStep(scope: FlowScope, id: unknown, stepId: unknown, revision?: unknown) {
    return this.database.transaction(async tx => {
      const flow = await this.owned(scope, id, tx, true); this.editable(flow, revision);
      const selected = uuid(stepId, 'stepId');
      const removed = flow.steps.find((step: any) => step._id === selected);
      if (!removed) fail(404, 'Step not found');
      const [row] = await tx('automation_flows').where({ id: flow.id }).update({ steps: JSON.stringify(this.steps(flow.steps.filter((step: any) => step._id !== selected), flow.steps)), revision: flow.revision + 1, updated_at: tx.fn.now(), ...(removed.type === 'trigger' ? { webhook_secret_ciphertext: null } : {}) }).returning('*');
      return this.format(row);
    });
  }
  async connectionFor(scope: FlowScope, appKey: string, id: string, database: Connection = this.database) {
    const table = appKey === 'shopify' ? 'shopify_connections' : appKey === 'google-sheets' ? 'google_sheet_connections' : 'automation_connections';
    if (!await database.schema.hasTable(table)) fail(409, `Set up the ${appKey} integration first`);
    const row = await database(table).where({ id: uuid(id, 'connectionId'), company_id: scope.companyId, [appKey === 'razorpay' ? 'user_id' : 'owner_id']: scope.userId }).first();
    if (!row || (appKey !== 'google-sheets' && row.status !== 'connected') || (appKey === 'razorpay' && row.app_key !== 'razorpay')) fail(404, 'Connected integration not found in your account');
    return row;
  }
  async connections(scope: FlowScope) {
    await this.actor(scope); const items: any[] = [];
    for (const appKey of ['shopify', 'google-sheets', 'razorpay']) {
      const table = appKey === 'shopify' ? 'shopify_connections' : appKey === 'google-sheets' ? 'google_sheet_connections' : 'automation_connections';
      if (!await this.database.schema.hasTable(table)) continue;
      const rows = await this.database(table).where({ company_id: scope.companyId, [appKey === 'razorpay' ? 'user_id' : 'owner_id']: scope.userId }).select(appKey === 'google-sheets' ? ['id', 'created_at'] : appKey === 'shopify' ? ['id', 'name', 'shop_domain', 'status', 'scopes', 'created_at'] : ['id', 'name', 'mode', 'status', 'created_at']);
      const apps = appKey === 'shopify' && await this.database.schema.hasTable('shopify_app_credentials')
        ? await this.database('shopify_app_credentials').where({ company_id: scope.companyId, owner_id: scope.userId }).select('connection_id', 'client_id') : [];
      items.push(...rows.map(row => { const app = apps.find(app => app.connection_id === row.id); return {
        ...row, _id: row.id, appKey, status: row.status || 'connected', name: row.name || 'Google Sheets',
        ...(appKey === 'shopify' ? { authentication: app ? 'client_credentials' : 'oauth', ...(app ? { client_id: app.client_id, credentials_configured: true } : {}) } : {}),
      }; }));
    }
    return items;
  }
  async createConnection(scope: FlowScope, input: unknown) {
    await this.actor(scope); const body = object(input);
    if (body.appKey === 'shopify') {
      const { appKey: _appKey, ...credentials } = body;
      return (await this.shopifyProvider()).connectClientCredentials({ companyId: scope.companyId!, ownerId: scope.userId!, userId: scope.userId! }, credentials);
    }
    if (body.appKey !== 'razorpay') fail(400, 'Use appKey shopify or razorpay; Google Sheets uses its OAuth connection API');
    if (!['test', 'live'].includes(body.mode)) fail(400, 'mode must be test or live');
    const keyId = text(body.key_id, 'key_id', 255), keySecret = text(body.key_secret, 'key_secret', 1024);
    if (!keyId.startsWith(`rzp_${body.mode}_`)) fail(400, 'Razorpay key_id must match the selected mode');
    const row = { id: randomUUID(), ...where(scope), app_key: 'razorpay', name: text(body.name, 'name', 120), mode: body.mode };
    await this.database('automation_connections').insert({ ...row, credentials_ciphertext: encrypt({ key_id: keyId, key_secret: keySecret }, credentialContext(row)) });
    return { id: row.id, _id: row.id, appKey: 'razorpay', name: row.name, mode: row.mode, status: 'connected', credentials_configured: true };
  }
  async disconnect(scope: FlowScope, id: unknown) {
    await this.actor(scope);
    const rows = await this.database('automation_connections').where({ ...where(scope), id: uuid(id) }).update({ status: 'disconnected', updated_at: this.database.fn.now() }).returning('id');
    if (!rows.length) fail(404, 'Razorpay flow connection not found');
    return { id, status: 'disconnected' };
  }
  async configureWebhook(scope: FlowScope, id: unknown, input: unknown) {
    const body = object(input), secret = text(body.signing_secret, 'signing_secret', 1024);
    if (secret.length < 16) fail(400, 'Use a webhook signing secret of at least 16 characters');
    return this.database.transaction(async tx => {
      const flow = await this.owned(scope, id, tx, true); this.editable(flow, body.revision);
      const trigger = flow.steps[0];
      if (!trigger || trigger.type !== 'trigger' || !triggers.some(t => t.appKey === trigger.appKey && t.key === trigger.key) || !trigger.connectionId) fail(400, 'Configure the trigger and its connection first');
      await this.connectionFor(scope, trigger.appKey, trigger.connectionId, tx);
      const token = body.rotate_token === true ? randomToken() : null;
      const [row] = await tx('automation_flows').where({ id: flow.id }).update({ webhook_secret_ciphertext: encrypt(secret, hookContext(flow.id)), revision: flow.revision + 1, updated_at: tx.fn.now(), ...(token ? { webhook_token_hash: hash(token), webhook_token_ciphertext: encrypt(token, hookContext(flow.id)) } : {}) }).returning('*');
      return { webhookPath: this.url(row), signing_secret_configured: true, revision: row.revision, topic: triggers.find(t => t.appKey === trigger.appKey && t.key === trigger.key)!.topic };
    });
  }
  private async providerWebhook(scope: FlowScope, flow: any, mode: 'ensure' | 'inspect' | 'remove') {
    const trigger = flow.steps[0];
    if (trigger?.type !== 'trigger' || trigger.appKey !== 'shopify') fail(400, 'Automatic webhook registration currently supports Shopify triggers');
    const definition = triggers.find(t => t.appKey === 'shopify' && t.key === trigger.key) || fail(400, 'Configure a supported Shopify trigger first');
    if (!trigger.connectionId) fail(400, 'Connect the Shopify store first');
    await this.connectionFor(scope, 'shopify', trigger.connectionId);
    const provider = await this.shopifyProvider();
    return provider.automationWebhook({ companyId: scope.companyId!, ownerId: scope.userId!, userId: scope.userId! },
      trigger.connectionId, flow.id, definition.topic, this.url(flow), mode);
  }
  async subscribeWebhook(scope: FlowScope, id: unknown, input: unknown) {
    const body = object(input);
    if (Object.keys(body).some(key => key !== 'revision')) fail(400, 'Only revision is accepted; Shopify app credentials stay on the server');
    const before = await this.owned(scope, id); this.editable(before, body.revision);
    if (before.steps[0]?.appKey !== 'shopify' || before.steps[0]?.type !== 'trigger')
      fail(400, 'Automatic webhook registration currently supports Shopify triggers');
    if (new URL(this.url(before)).protocol !== 'https:') fail(400, 'Configure a public HTTPS automation URL before registering Shopify webhooks');
    // Authenticate early deliveries before registering the remote subscription. A failed call is retryable.
    const signingSecret = await (await this.shopifyProvider()).automationSigningSecret({ companyId: scope.companyId!, ownerId: scope.userId!, userId: scope.userId! }, before.steps[0].connectionId);
    const configured = await this.configureWebhook(scope, id, { revision: before.revision, signing_secret: signingSecret });
    const flow = await this.owned(scope, id);
    if (flow.revision !== configured.revision) fail(409, 'Flow changed during webhook setup; reload and retry');
    const subscription = await this.providerWebhook(scope, flow, 'ensure');
    const current = await this.owned(scope, id);
    if (current.revision !== flow.revision) fail(409, 'Flow changed during webhook setup; reload and retry to reconcile the subscription');
    return { ...subscription, signing_secret_configured: true, authentication: 'shopify_app', revision: current.revision };
  }
  async webhookStatus(scope: FlowScope, id: unknown) {
    const flow = await this.owned(scope, id);
    const subscription = await this.providerWebhook(scope, flow, 'inspect');
    const appSecret = await (await this.shopifyProvider()).automationSigningSecret({ companyId: scope.companyId!, ownerId: scope.userId!, userId: scope.userId! }, flow.steps[0].connectionId);
    const automatic = !!flow.webhook_secret_ciphertext && decrypt(flow.webhook_secret_ciphertext, hookContext(flow.id)) === appSecret;
    return { ...subscription, signing_secret_configured: !!flow.webhook_secret_ciphertext,
      authentication: automatic ? 'shopify_app' : 'manual', ready: !!subscription.subscribed && automatic, revision: flow.revision };
  }
  async unsubscribeWebhook(scope: FlowScope, id: unknown, input: unknown) {
    const body = object(input);
    if (Object.keys(body).some(key => key !== 'revision')) fail(400, 'Only revision is accepted');
    const flow = await this.owned(scope, id); this.editable(flow, body.revision);
    const subscription = await this.providerWebhook(scope, flow, 'remove');
    return this.database.transaction(async tx => {
      const current = await this.owned(scope, id, tx, true); this.editable(current, flow.revision);
      await tx('automation_flows').where({ id: current.id }).update({ webhook_secret_ciphertext: null, revision: current.revision + 1, updated_at: tx.fn.now() });
      return { ...subscription, signing_secret_configured: false, revision: current.revision + 1 };
    });
  }
  async validateReady(scope: FlowScope, flow: any, database: Connection = this.database) {
    if (flow.steps[0]?.type !== 'trigger') fail(400, 'Add and configure a trigger before running this flow');
    if (flow.steps.length < 2) fail(400, 'Add at least one action');
    for (const [index, step] of flow.steps.entries()) {
      if (step.status !== 'complete') fail(400, `Complete step ${index + 1} before running this flow`);
      await this.connectionFor(scope, step.appKey, step.connectionId, database);
      if (index) validateParameters(action(step.appKey, step.key), step.parameters, true);
    }
  }
  async status(scope: FlowScope, id: unknown, input: unknown) {
    const body = object(input);
    if (!['active', 'inactive'].includes(body.status)) fail(400, 'status must be active or inactive');
    return this.database.transaction(async tx => {
      const flow = await this.owned(scope, id, tx, true);
      if (body.revision !== undefined && body.revision !== flow.revision) fail(409, 'Flow changed; reload before saving');
      if (body.status === 'active') { await this.validateReady(scope, flow, tx); if (!flow.webhook_secret_ciphertext) fail(400, 'Configure the webhook signing secret first'); }
      const [row] = await tx('automation_flows').where({ id: flow.id }).update({ status: body.status, revision: flow.revision + 1, updated_at: tx.fn.now() }).returning('*');
      return this.format(row);
    });
  }
  async remove(scope: FlowScope, id: unknown) {
    return this.database.transaction(async tx => {
      const flow = await this.owned(scope, id, tx, true);
      await tx('automation_flows').where({ id: flow.id }).update({ deleted_at: tx.fn.now(), status: 'inactive', updated_at: tx.fn.now() });
      await tx('automation_runs').where({ flow_id: flow.id, status: 'queued' }).update({ status: 'cancelled', finished_at: tx.fn.now() });
      return { id: flow.id, deleted: true };
    });
  }
  private async queueRun(flow: any, eventId: string, requestId: string, kind: string, tx: Connection) {
    const [row] = await tx('automation_runs').insert({ id: randomUUID(), flow_id: flow.id, event_id: eventId, request_id: requestId, kind, revision: flow.revision, definition: JSON.stringify(flow.steps) }).onConflict(['flow_id', 'request_id']).ignore().returning('*');
    if (row) return this.publicRun(row);
    const existing = await tx('automation_runs').where({ flow_id: flow.id, request_id: requestId }).first();
    if (existing.event_id !== eventId || existing.kind !== kind) fail(409, 'request_id is already used for a different run');
    return this.publicRun(existing);
  }
  async receive(id: unknown, token: unknown, raw: Buffer, headers: Record<string, any>) {
    const flowId = uuid(id, 'flowId');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'Invalid webhook destination');
    return this.database.transaction(async tx => {
      const flow = await tx('automation_flows').where({ id: flowId, webhook_token_hash: hash(token as string) }).whereNull('deleted_at').forUpdate().first();
      if (!flow || !flow.webhook_secret_ciphertext) fail(404, 'Configured flow webhook not found');
      const trigger = flow.steps[0];
      if (trigger?.type !== 'trigger') fail(409, 'Configure a supported webhook trigger');
      const definition = triggers.find(t => t.appKey === trigger.appKey && t.key === trigger.key) || fail(409, 'Configure a supported webhook trigger');
      verifySignature(raw, headers[trigger.appKey === 'shopify' ? 'x-shopify-hmac-sha256' : 'x-razorpay-signature'], decrypt(flow.webhook_secret_ciphertext, hookContext(flow.id)), trigger.appKey);
      let payload: any; try { payload = JSON.parse(raw.toString('utf8')); } catch { return fail(400, 'Invalid JSON webhook'); }
      object(payload);
      const scope = { userId: flow.user_id, companyId: flow.company_id }; await this.actor(scope, tx);
      const connection = await this.connectionFor(scope, trigger.appKey, trigger.connectionId, tx);
      if (trigger.appKey === 'shopify' && headers['x-shopify-shop-domain'] !== connection.shop_domain) fail(403, 'Webhook store does not match this flow connection');
      if (trigger.appKey === 'shopify') {
        const lock = await tx.raw('select pg_try_advisory_xact_lock(hashtext(?)) as locked', [`shopify:${connection.shop_domain}`]);
        if (!lock.rows[0].locked) fail(503, 'Store maintenance is in progress; retry this webhook delivery');
      }
      const topic = trigger.appKey === 'shopify' ? headers['x-shopify-topic'] : payload.event;
      if (topic !== definition.topic) return { accepted: false, ignored: true, reason: 'topic_not_configured' };
      const hashes = trigger.appKey === 'shopify' ? subjectHashes(topic, payload, `${connection.company_id}:${connection.owner_id}:${connection.shop_domain}`) : [];
      if (hashes.length && await tx.schema.hasTable('shopify_redactions') && await tx('shopify_redactions').where({ connection_id: connection.id }).whereIn('subject_hash', hashes).where('expires_at', '>', new Date()).first()) return { accepted: true, ignored: true, reason: 'customer_erased' };
      const sourceId = headers[trigger.appKey === 'shopify' ? 'x-shopify-event-id' : 'x-razorpay-event-id'] || headers['x-shopify-webhook-id'] || hash(raw);
      const eventId = randomUUID();
      const [event] = await tx('automation_events').insert({ id: eventId, flow_id: flow.id, app_key: trigger.appKey, connection_id: connection.id, subject_hashes: JSON.stringify(hashes), source_event_id: text(sourceId, 'event ID', 200), topic, payload_ciphertext: encrypt(payload, `event:${eventId}`) }).onConflict(['flow_id', 'source_event_id']).ignore().returning('id');
      if (!event) return { accepted: true, duplicate: true };
      const run = flow.status === 'active' ? await this.queueRun(flow, event.id, event.id, 'automatic', tx) : null;
      return { accepted: true, duplicate: false, event_id: event.id, run_id: run?.id || null, mode: run ? 'queued' : 'capture_only' };
    });
  }
  async events(scope: FlowScope, id: unknown, eventId?: unknown) {
    const flow = await this.owned(scope, id);
    const query = this.database('automation_events').where({ flow_id: flow.id }).where('expires_at', '>', new Date());
    if (eventId !== undefined) {
      const row = await query.where({ id: uuid(eventId, 'eventId') }).first();
      if (!row) fail(404, 'Event not found');
      const payload = decrypt(row.payload_ciphertext, `event:${row.id}`);
      return { id: row.id, flow_id: row.flow_id, topic: row.topic, received_at: row.received_at, payload,
        ...(row.app_key === 'shopify' ? { contact: shopifyContact(payload) } : {}) };
    }
    return query.select('id', 'flow_id', 'topic', 'source_event_id', 'received_at').orderBy('received_at', 'desc').orderBy('id').limit(50);
  }
  publicRun(row: any, detail = false) {
    return { id: row.id, flow_id: row.flow_id, event_id: row.event_id, request_id: row.request_id, kind: row.kind, revision: row.revision, status: row.status, error: row.error, created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at, ...(detail ? { steps: row.results_ciphertext ? decrypt(row.results_ciphertext, `run:${row.id}`) : [] } : {}) };
  }
  async testRun(scope: FlowScope, id: unknown, input: unknown) {
    const body = object(input), eventId = uuid(body.event_id, 'event_id'), requestId = uuid(body.request_id, 'request_id');
    return this.database.transaction(async tx => {
      const flow = await this.owned(scope, id, tx, true); await this.validateReady(scope, flow, tx);
      const event = await tx('automation_events').where({ id: eventId, flow_id: flow.id }).where('expires_at', '>', new Date()).first('id', 'topic');
      if (!event) fail(404, 'Choose a captured event from this flow');
      if (event.topic !== triggers.find(t => t.appKey === flow.steps[0].appKey && t.key === flow.steps[0].key)?.topic) fail(400, 'Capture an event for the currently selected trigger before testing');
      return this.queueRun(flow, eventId, requestId, 'manual', tx);
    });
  }
  async runs(scope: FlowScope, id: unknown, runId?: unknown) {
    const flow = await this.owned(scope, id);
    const query = this.database('automation_runs').where({ flow_id: flow.id });
    if (runId !== undefined) {
      const row = await query.where({ id: uuid(runId, 'runId') }).first();
      if (!row) fail(404, 'Run not found');
      return this.publicRun(row, true);
    }
    return (await query.orderBy('created_at', 'desc').orderBy('id').limit(50)).map(row => this.publicRun(row));
  }
  credentials(connection: any) { return decrypt(connection.credentials_ciphertext, credentialContext(connection)); }
}
export default new AutomationFlowService();
