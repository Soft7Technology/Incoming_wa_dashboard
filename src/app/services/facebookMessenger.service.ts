import crypto from 'crypto';
import { Knex } from 'knex';
import db from '@surefy/database';
import graph, { FacebookGraph } from './facebookGraph.service';
import {
  config,
  decrypt,
  encrypt,
  FacebookError,
  hash,
  permissions,
  random,
  replyWindow,
  subscriptions,
  uuidPattern,
} from '../utils/facebook';

export interface FacebookScope {
  companyId: string;
  ownerId: string;
  userId: string;
}
const publicPageFields = [
  'id',
  'page_id',
  'name',
  'status',
  'error',
  'connected_at',
  'updated_at',
  'token_expires_at',
  'data_access_expires_at',
];
const scoped = (database: Knex, scope: FacebookScope) =>
  database('facebook_pages').where({ company_id: scope.companyId, owner_id: scope.ownerId });
const safeError = (error: unknown) =>
  error instanceof FacebookError
    ? error
    : new FacebookError(500, 'Facebook operation could not be completed. Please try again.');

export class FacebookMessengerService {
  constructor(
    private database: Knex = db,
    private meta: FacebookGraph = graph,
  ) {}

  async access(scope: FacebookScope, capability: 'manage' | 'inbox') {
    if (!scope.companyId || !scope.ownerId || !scope.userId)
      throw new FacebookError(403, 'A company account is required.');
    const company = await this.database('companies')
      .where({ id: scope.companyId, status: 'active' })
      .whereNull('deleted_at')
      .first('id');
    if (!company) throw new FacebookError(403, 'Company account is unavailable.');
    const owner = await this.database('users')
      .where({ id: scope.ownerId, company_id: scope.companyId, status: 'active' })
      .whereNull('deleted_at')
      .first('id');
    if (!owner) throw new FacebookError(403, 'Account owner is unavailable.');
    if (scope.userId === scope.ownerId) return;
    if (capability === 'manage')
      throw new FacebookError(403, 'Only the account owner can connect or disconnect Facebook Pages.');
    const member = await this.database('users as u')
      .join('user_team as t', 't.email', 'u.email')
      .where({
        'u.id': scope.userId,
        'u.company_id': scope.companyId,
        'u.status': 'active',
        't.company_id': scope.companyId,
        't.invite_sent_by': scope.ownerId,
        't.invite_status': 'accepted',
      })
      .whereNull('u.deleted_at')
      .first('t.permission');
    const grants = Array.isArray(member?.permission) ? member.permission : member?.permission?.nav;
    if (
      !Array.isArray(grants) ||
      !grants.some(
        (p: unknown) => typeof p === 'string' && ['inbox', 'messenger', 'facebook-messenger'].includes(p.toLowerCase()),
      )
    ) {
      throw new FacebookError(403, 'Your team membership requires inbox permission.');
    }
  }

  async start(scope: FacebookScope) {
    await this.access(scope, 'manage');
    const c = config();
    const state = random(),
      browser = random();
    await this.database('facebook_oauth_sessions').where('expires_at', '<', new Date()).delete();
    await this.database('facebook_oauth_sessions').insert({
      state_hash: hash(state),
      browser_hash: hash(browser),
      company_id: scope.companyId,
      owner_id: scope.ownerId,
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
    });
    const url = new URL(`https://www.facebook.com/${c.version}/dialog/oauth`);
    const params: Record<string, string> = {
      client_id: c.appId,
      redirect_uri: c.callback,
      state,
      response_type: 'code',
    };
    if (process.env.FACEBOOK_LOGIN_MODE === 'classic') {
      params.scope = permissions.join(',');
      params.auth_type = 'rerequest';
    } else {
      params.config_id = process.env.FACEBOOK_LOGIN_CONFIG_ID!;
      params.override_default_response_type = 'true';
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { browser, url: url.toString() };
  }

  async callback(state: unknown, browser: string | undefined, code: unknown, cancelled: boolean) {
    if (typeof state !== 'string' || !browser)
      throw new FacebookError(403, 'Facebook login session is missing. Start Connect Facebook Page again.');
    const [session] = await this.database('facebook_oauth_sessions')
      .where({ state_hash: hash(state), browser_hash: hash(browser), status: 'started' })
      .where('expires_at', '>', new Date())
      .update({ status: 'authorizing' })
      .returning('*');
    if (!session) throw new FacebookError(403, 'Facebook login session expired or was already used. Connect again.');
    try {
      await this.access(
        { companyId: session.company_id, ownerId: session.owner_id, userId: session.owner_id },
        'manage',
      );
      if (cancelled)
        throw new FacebookError(400, 'Facebook login was cancelled. No new Page was connected.', 'LOGIN_CANCELLED');
      if (typeof code !== 'string' || !code)
        throw new FacebookError(400, 'Facebook did not return an authorization code. Connect again.');
      const auth = await this.meta.authorize(code);
      const missing = permissions.filter((p) => !auth.granted.includes(p));
      if (missing.length)
        throw new FacebookError(
          403,
          `Missing Facebook permissions: ${missing.join(', ')}. Connect again and grant all required permissions.`,
          'MISSING_PERMISSIONS',
        );
      const pages = await this.meta.pages(auth.token);
      if (!pages.length)
        throw new FacebookError(
          403,
          'No eligible Pages found. Select your Page in Facebook consent and verify that you have its messaging task.',
        );
      await this.database('facebook_oauth_sessions')
        .where({ state_hash: session.state_hash })
        .update({
          status: 'ready',
          facebook_user_id: auth.userId,
          candidates_ciphertext: encrypt(JSON.stringify({ pages, dataExpires: auth.dataExpires })),
        });
      return 'ready';
    } catch (error) {
      const failure = safeError(error);
      await this.database('facebook_oauth_sessions')
        .where({ state_hash: session.state_hash })
        .update({ status: 'failed', error: failure.message, candidates_ciphertext: null });
      return 'failed';
    }
  }

  async session(scope: FacebookScope, browser: string | undefined) {
    if (!browser) return null;
    return await this.database('facebook_oauth_sessions')
      .where({ browser_hash: hash(browser), company_id: scope.companyId, owner_id: scope.ownerId })
      .where('expires_at', '>', new Date())
      .first();
  }

  async candidates(scope: FacebookScope, browser: string | undefined) {
    await this.access(scope, 'manage');
    const session = await this.session(scope, browser);
    if (!session) return { status: 'none', pages: [], error: null };
    const payload =
      session.status === 'ready' && session.candidates_ciphertext
        ? JSON.parse(decrypt(session.candidates_ciphertext))
        : { pages: [] };
    return {
      status: session.status,
      error: session.error,
      pages: payload.pages.map((p: any) => ({ page_id: p.id, name: p.name })),
    };
  }

  async connect(scope: FacebookScope, browser: string | undefined, pageId: unknown) {
    await this.access(scope, 'manage');
    if (typeof pageId !== 'string' || !/^\d{1,80}$/.test(pageId))
      throw new FacebookError(400, 'Select a Facebook Page.');
    const session = await this.session(scope, browser);
    if (session?.status !== 'ready' || !session.candidates_ciphertext)
      throw new FacebookError(409, 'Facebook Page selection expired. Connect again.');
    const payload = JSON.parse(decrypt(session.candidates_ciphertext));
    const page = payload.pages.find((p: any) => String(p.id) === pageId);
    if (!page) throw new FacebookError(403, 'This Page was not authorized in your current Facebook login.');
    const details = await this.meta.inspectPage(pageId, page.access_token);
    // Serialize Page ownership and subscription changes across all API replicas.
    return this.database.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`facebook-page:${pageId}`]);
      const existing = await trx('facebook_pages').where({ page_id: pageId }).forUpdate().first();
      if (existing && (existing.company_id !== scope.companyId || existing.owner_id !== scope.ownerId))
        throw new FacebookError(
          409,
          'This Page is connected to another account. Its owner must delete the stored integration before transferring it.',
        );
      const activeSession = await trx('facebook_oauth_sessions')
        .where({ state_hash: session.state_hash, status: 'ready' })
        .where('expires_at', '>', new Date())
        .forUpdate()
        .first();
      if (!activeSession)
        throw new FacebookError(409, 'Facebook Page selection expired or was already used. Connect again.');
      let status = 'connected',
        error: string | null = null;
      try {
        const result = await this.meta.call(
          `${pageId}/subscribed_apps`,
          page.access_token,
          'POST',
          {},
          { subscribed_fields: subscriptions.join(',') },
        );
        if (result.success !== true) throw new FacebookError(502, 'Meta did not confirm the webhook subscription.');
        const check = await this.meta.call(`${pageId}/subscribed_apps`, page.access_token, 'GET', {
          fields: 'id,subscribed_fields',
        });
        const app = check.data?.find((a: any) => String(a.id) === config().appId);
        if (!app || !subscriptions.every((s) => (app.subscribed_fields || []).includes(s)))
          throw new FacebookError(
            502,
            'Meta webhook subscription could not be verified. Check app webhook fields and reconnect.',
          );
      } catch (failure) {
        status = 'subscription_failed';
        error = safeError(failure).message;
      }
      const values = {
        company_id: scope.companyId,
        owner_id: scope.ownerId,
        page_id: pageId,
        // Use the name Meta returned in this browser-bound authorization.
        name: page.name,
        facebook_user_id: session.facebook_user_id,
        token_ciphertext: encrypt(page.access_token),
        token_expires_at: details.expires,
        data_access_expires_at: payload.dataExpires,
        status,
        error,
        updated_at: new Date(),
        connected_at: status === 'connected' ? new Date() : existing?.connected_at || null,
      };
      const [saved] = existing
        ? await trx('facebook_pages').where({ id: existing.id }).update(values).returning(publicPageFields)
        : await trx('facebook_pages').insert(values).returning(publicPageFields);
      await trx('facebook_oauth_sessions')
        .where({ state_hash: session.state_hash })
        .update({ status: 'completed', candidates_ciphertext: null });
      return saved;
    });
  }

  async pages(scope: FacebookScope) {
    await this.access(scope, 'inbox');
    await scoped(this.database, scope)
      .where({ status: 'connected' })
      .where((q) => q.where('token_expires_at', '<=', new Date()).orWhere('data_access_expires_at', '<=', new Date()))
      .update({
        status: 'reconnect_required',
        error: 'Facebook authorization expired. Reconnect this Page.',
        updated_at: new Date(),
      });
    return scoped(this.database, scope).select(publicPageFields).orderBy('name');
  }

  async disconnect(scope: FacebookScope, id: string, erase = false) {
    await this.access(scope, 'manage');
    this.validateId(id);
    return this.database.transaction(async (trx) => {
      const page = await scoped(trx, scope).where({ id }).forUpdate().first();
      if (!page) throw new FacebookError(404, 'Page not found in your account.');
      let warning: string | null = null;
      if (page.token_ciphertext && page.status !== 'disconnected') {
        try {
          const result = await this.meta.call(
            `${page.page_id}/subscribed_apps`,
            decrypt(page.token_ciphertext),
            'DELETE',
          );
          if (result.success !== true) throw new FacebookError(502, 'Meta did not confirm unsubscription.');
        } catch {
          warning =
            'Disconnected locally. Meta unsubscription could not be confirmed; remove this app in Facebook Business Integrations if necessary.';
        }
      }
      // Remove pending candidate tokens too, so disconnect actually revokes local access.
      await trx('facebook_oauth_sessions').where({ company_id: scope.companyId, owner_id: scope.ownerId }).delete();
      if (erase) await trx('facebook_pages').where({ id }).delete();
      else
        await trx('facebook_pages')
          .where({ id })
          .update({ token_ciphertext: null, status: 'disconnected', error: warning, updated_at: new Date() });
      return { disconnected: true, deleted: erase, warning };
    });
  }

  validateId(id: string) {
    if (!uuidPattern.test(id)) throw new FacebookError(400, 'Invalid resource ID.');
  }

  async conversation(scope: FacebookScope, id: string, database = this.database) {
    this.validateId(id);
    const c = await database('facebook_conversations as c')
      .join('facebook_pages as p', 'p.id', 'c.page_connection_id')
      .where({ 'c.id': id, 'p.company_id': scope.companyId, 'p.owner_id': scope.ownerId })
      .select('c.*', 'p.name as page_name', 'p.page_id', 'p.status as connection_status')
      .first();
    if (!c) throw new FacebookError(404, 'Conversation not found in your account.');
    return { ...c, ...replyWindow(c.last_customer_message_at) };
  }

  async conversations(scope: FacebookScope, before?: string) {
    await this.access(scope, 'inbox');
    const query = this.database('facebook_conversations as c')
      .join('facebook_pages as p', 'p.id', 'c.page_connection_id')
      .where({ 'p.company_id': scope.companyId, 'p.owner_id': scope.ownerId })
      .select('c.*', 'p.name as page_name', 'p.page_id', 'p.status as connection_status')
      .orderBy('c.last_message_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(100);
    if (before) {
      const [at, id] = before.split('|');
      this.validateId(id || '');
      if (!Number.isFinite(Date.parse(at))) throw new FacebookError(400, 'Invalid conversation cursor.');
      query.whereRaw('(c.last_message_at, c.id) < (?, ?::uuid)', [new Date(at), id]);
    }
    const rows = await query;
    const last = rows[rows.length - 1];
    return {
      conversations: rows.map((c) => ({ ...c, ...replyWindow(c.last_customer_message_at) })),
      next_cursor: rows.length === 100 ? `${new Date(last.last_message_at).toISOString()}|${last.id}` : null,
    };
  }

  async messages(scope: FacebookScope, id: string, before?: string) {
    await this.access(scope, 'inbox');
    const conversation = await this.conversation(scope, id);
    const query = this.database('facebook_messages')
      .where({ conversation_id: id })
      .orderBy('event_at', 'desc')
      .orderBy('id', 'desc')
      .limit(100);
    if (before) {
      const [at, messageId] = before.split('|');
      this.validateId(messageId || '');
      if (!Number.isFinite(Date.parse(at))) throw new FacebookError(400, 'Invalid message cursor.');
      query.whereRaw('(event_at, id) < (?, ?::uuid)', [new Date(at), messageId]);
    }
    const rows = await query;
    const last = rows[rows.length - 1];
    return {
      conversation,
      messages: rows.reverse(),
      next_cursor: rows.length === 100 ? `${new Date(last.event_at).toISOString()}|${last.id}` : null,
    };
  }

  async send(scope: FacebookScope, id: string, text: unknown, requestId: unknown) {
    await this.access(scope, 'inbox');
    if (typeof text !== 'string' || !text.trim() || text.length > 2000)
      throw new FacebookError(400, 'Reply must contain 1–2000 characters.');
    if (typeof requestId !== 'string' || !uuidPattern.test(requestId))
      throw new FacebookError(400, 'A UUID client_request_id is required to prevent duplicate replies.');
    const prepared = await this.database.transaction(async (trx) => {
      const c = await this.conversation(scope, id, trx);
      const page = await scoped(trx, scope).where({ id: c.page_connection_id }).forUpdate().first();
      const existing = await trx('facebook_messages')
        .where({ conversation_id: id, client_request_id: requestId })
        .first();
      if (existing) {
        if (existing.text !== text.trim())
          throw new FacebookError(409, 'This reply request ID was already used for different text.');
        return { existing };
      }
      if (page.status !== 'connected' || !page.token_ciphertext)
        throw new FacebookError(409, 'Page is not connected. Ask the account owner to reconnect.');
      if (
        (page.token_expires_at && new Date(page.token_expires_at).getTime() <= Date.now()) ||
        (page.data_access_expires_at && new Date(page.data_access_expires_at).getTime() <= Date.now())
      ) {
        throw new FacebookError(409, 'Facebook authorization expired. Reconnect this Page.', 'TOKEN_EXPIRED');
      }
      if (!c.can_reply) throw new FacebookError(409, c.reply_block_reason!, 'WINDOW_CLOSED');
      const [message] = await trx('facebook_messages')
        .insert({
          id: crypto.randomUUID(),
          conversation_id: id,
          page_connection_id: page.id,
          client_request_id: requestId,
          agent_id: scope.userId,
          direction: 'outbound',
          text: text.trim(),
          status: 'pending',
          event_at: new Date(),
        })
        .returning('*');
      return { page, c, message };
    });
    if (prepared.existing) return prepared.existing;
    const { page, c, message } = prepared;
    try {
      const result = await this.meta.call(
        `${page.page_id}/messages`,
        decrypt(page.token_ciphertext),
        'POST',
        {},
        {
          recipient: { id: c.psid },
          messaging_type: 'RESPONSE',
          message: { text: message.text, metadata: `fm:${message.id}` },
        },
      );
      if (!result.message_id || String(result.recipient_id) !== c.psid)
        throw new FacebookError(
          502,
          'Meta did not confirm this reply. Check native Messenger before sending again.',
          'META_UNCONFIRMED',
        );
      await this.database.transaction(async (trx) => {
        const locked = await trx('facebook_conversations').where({ id }).forUpdate().first();
        if (!locked) return; // A signed data deletion may remove the conversation during the request.
        const current = await trx('facebook_messages').where({ id: message.id }).first();
        if (!current) return;
        const status = this.receiptStatus(
          locked,
          new Date(current.event_at).getTime(),
          current.status === 'pending' || current.status === 'failed' ? 'sent' : current.status,
        );
        await trx('facebook_messages')
          .where({ id: message.id })
          .update({ meta_message_id: String(result.message_id), status, error: null });
        await trx('facebook_conversations')
          .where({ id })
          .update({ last_message_at: trx.raw('GREATEST(last_message_at, ?::timestamptz)', [current.event_at]) });
      });
    } catch (error) {
      const failure = safeError(error);
      await this.database('facebook_messages')
        .where({ id: message.id, status: 'pending' })
        .update({ status: 'failed', error: failure.message });
      if (failure.code === 'TOKEN_EXPIRED' || failure.code === 'PERMISSION_DENIED')
        await scoped(this.database, scope)
          .where({ id: page.id, status: 'connected' })
          .update({ status: 'reconnect_required', error: failure.message, updated_at: new Date() });
    }
    const saved = await this.database('facebook_messages').where({ id: message.id }).first();
    if (!saved) throw new FacebookError(410, 'This conversation was deleted during the send request.');
    return saved;
  }

  receiptStatus(conversation: any, at: number, fallback: string) {
    if (fallback === 'read' || Number(conversation.read_watermark) >= at) return 'read';
    if (fallback === 'delivered' || Number(conversation.delivery_watermark) >= at) return 'delivered';
    return fallback;
  }

  async receive(body: any) {
    if (body?.object !== 'page' || !Array.isArray(body.entry)) return;
    for (const entry of body.entry) {
      if (!/^\d{1,80}$/.test(String(entry.id))) continue;
      for (const event of Array.isArray(entry.messaging) ? entry.messaging : []) {
        await this.database.transaction(async (trx) => {
          const page = await trx('facebook_pages')
            .where({ page_id: String(entry.id), status: 'connected' })
            .forUpdate()
            .first();
          if (!page) return;
          const echo = event.message?.is_echo === true;
          if (String(echo ? event.sender?.id : event.recipient?.id) !== page.page_id) return;
          const psid = String(echo ? event.recipient?.id : event.sender?.id);
          if (!/^\d{1,80}$/.test(psid) || psid === page.page_id) return;
          if (event.message) await this.receiveMessage(trx, page, psid, event, echo);
          else if (event.delivery || event.read) await this.receiveReceipt(trx, page, psid, event);
        });
      }
    }
  }

  private async receiveMessage(trx: Knex.Transaction, page: any, psid: string, event: any, echo: boolean) {
    const mid = event.message.mid;
    if (
      typeof mid !== 'string' ||
      !mid ||
      mid.length > 255 ||
      !Number.isFinite(event.timestamp) ||
      event.timestamp <= 0
    )
      return;
    const at = new Date(Math.min(event.timestamp, Date.now()));
    // Exact Meta message IDs deduplicate redelivery regardless of its envelope.
    const existing = await trx('facebook_messages')
      .where({ page_connection_id: page.id, meta_message_id: mid })
      .first();
    if (existing && !echo) return;
    let pending;
    const metadata = event.message.metadata;
    if (echo && typeof metadata === 'string' && metadata.startsWith('fm:') && uuidPattern.test(metadata.slice(3))) {
      pending = await trx('facebook_messages')
        .where({ id: metadata.slice(3), page_connection_id: page.id, direction: 'outbound' })
        .first();
      if (pending) {
        const conversation = await trx('facebook_conversations')
          .where({ id: pending.conversation_id, psid })
          .forUpdate()
          .first();
        if (!conversation) return;
        if (existing && existing.id !== pending.id) await trx('facebook_messages').where({ id: existing.id }).delete();
        await trx('facebook_messages')
          .where({ id: pending.id })
          .update({
            meta_message_id: mid,
            event_at: at,
            status: this.receiptStatus(
              conversation,
              at.getTime(),
              ['read', 'delivered'].includes(pending.status) ? pending.status : 'sent',
            ),
            error: null,
          });
        await trx('facebook_conversations')
          .where({ id: conversation.id })
          .update({ last_message_at: trx.raw('GREATEST(last_message_at, ?::timestamptz)', [at]) });
        return;
      }
    }
    if (existing) return;
    const [conversation] = await trx('facebook_conversations')
      .insert({ page_connection_id: page.id, psid, last_message_at: at })
      .onConflict(['page_connection_id', 'psid'])
      .merge({ psid })
      .returning('*');
    const text =
      typeof event.message.text === 'string' ? event.message.text : '[Non-text Messenger message; reply with text]';
    const rows = await trx('facebook_messages')
      .insert({
        id: crypto.randomUUID(),
        page_connection_id: page.id,
        conversation_id: conversation.id,
        meta_message_id: mid,
        direction: echo ? 'outbound' : 'inbound',
        text,
        status: echo ? this.receiptStatus(conversation, at.getTime(), 'sent') : 'received',
        event_at: at,
      })
      .onConflict(['page_connection_id', 'meta_message_id'])
      .ignore()
      .returning('id');
    if (rows.length)
      await trx('facebook_conversations')
        .where({ id: conversation.id })
        .update({
          last_message_at: trx.raw('GREATEST(last_message_at, ?::timestamptz)', [at]),
          ...(!echo
            ? { last_customer_message_at: trx.raw('GREATEST(last_customer_message_at, ?::timestamptz)', [at]) }
            : {}),
        });
  }

  private async receiveReceipt(trx: Knex.Transaction, page: any, psid: string, event: any) {
    const conversation = await trx('facebook_conversations')
      .where({ page_connection_id: page.id, psid })
      .forUpdate()
      .first();
    if (!conversation) return;
    const receipt = event.read || event.delivery;
    const watermark = Number(receipt.watermark);
    const read = Boolean(event.read);
    const column = read ? 'read_watermark' : 'delivery_watermark';
    if (Number.isFinite(watermark) && watermark > 0) {
      const at = Math.min(watermark, Date.now());
      await trx('facebook_conversations')
        .where({ id: conversation.id })
        .update({ [column]: trx.raw('GREATEST(??, ?)', [column, at]) });
      await trx('facebook_messages')
        .where({ conversation_id: conversation.id, direction: 'outbound' })
        .whereNotNull('meta_message_id')
        .whereIn('status', read ? ['sent', 'delivered'] : ['sent'])
        .where('event_at', '<=', new Date(at))
        .update({ status: read ? 'read' : 'delivered', error: null });
    }
    if (!read && Array.isArray(receipt.mids))
      await trx('facebook_messages')
        .where({ conversation_id: conversation.id, direction: 'outbound' })
        .whereIn(
          'meta_message_id',
          receipt.mids.filter((mid: unknown) => typeof mid === 'string'),
        )
        .whereIn('status', ['sent'])
        .update({ status: 'delivered', error: null });
  }

  async revoke(facebookUserId: string, erase: boolean) {
    const pages = await this.database('facebook_pages').where({ facebook_user_id: facebookUserId });
    // Meta may already have revoked tokens. Local revocation/deletion always proceeds.
    for (const page of pages) {
      if (page.token_ciphertext) {
        try {
          await this.meta.call(`${page.page_id}/subscribed_apps`, decrypt(page.token_ciphertext), 'DELETE');
        } catch {
          /* No token or payload logging. */
        }
      }
    }
    await this.database.transaction(async (trx) => {
      await trx('facebook_oauth_sessions').where({ facebook_user_id: facebookUserId }).delete();
      if (erase) await trx('facebook_pages').where({ facebook_user_id: facebookUserId }).delete();
      else
        await trx('facebook_pages')
          .where({ facebook_user_id: facebookUserId })
          .update({
            status: 'disconnected',
            token_ciphertext: null,
            error: 'Facebook authorization was removed. Reconnect to resume support.',
            updated_at: new Date(),
          });
    });
    if (!erase) return null;
    const confirmation = random();
    await this.database('facebook_deletion_requests').insert({
      confirmation_hash: hash(confirmation),
      status: 'completed',
    });
    return confirmation;
  }

  async deletionStatus(confirmation: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(confirmation)) throw new FacebookError(404, 'Deletion confirmation not found.');
    const request = await this.database('facebook_deletion_requests')
      .where({ confirmation_hash: hash(confirmation) })
      .first('status', 'completed_at');
    if (!request) throw new FacebookError(404, 'Deletion confirmation not found.');
    return request;
  }
}

export default new FacebookMessengerService();
