import { Knex } from 'knex';
import db from '@surefy/database';
import graph, { FacebookGraph } from './facebookGraph.service';
import directGraph, {
  InstagramGraph,
  directInstagramConfig,
  directInstagramPermissions,
  directInstagramLoginScopes,
} from './instagramGraph.service';
import { FacebookMessengerService, FacebookScope } from './facebookMessenger.service';
import { config, decrypt, encrypt, FacebookError, hash, random, uuidPattern } from '../utils/facebook';

export const instagramPermissions = [
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
];
const publicFields = [
  'id',
  'instagram_id',
  'page_id',
  'page_name',
  'username',
  'status',
  'connected_at',
  'auth_provider',
];
const numeric = (v: unknown): v is string => typeof v === 'string' && /^\d{1,80}$/.test(v);
const fail = (message: string, status = 400): never => {
  throw new FacebookError(status, message);
};
const scoped = (db: Knex, s: FacebookScope) =>
  db('instagram_accounts').where({ company_id: s.companyId, owner_id: s.ownerId });
const date = (v: unknown) => {
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) && n > 0 && n <= Date.now() + 60000 ? new Date(n) : null;
};

export function instagramConfig(provider = process.env.INSTAGRAM_AUTH_PROVIDER || 'instagram') {
  if (provider === 'instagram') return { ...directInstagramConfig(), provider };
  if (provider !== 'facebook') throw new FacebookError(400, 'Choose Instagram or Facebook login.');
  const c = config('transport');
  const mode = process.env.INSTAGRAM_LOGIN_MODE || process.env.FACEBOOK_LOGIN_MODE;
  if (mode !== 'classic' && !process.env.INSTAGRAM_LOGIN_CONFIG_ID)
    throw new FacebookError(
      503,
      'Set INSTAGRAM_LOGIN_CONFIG_ID to a Facebook Login for Business configuration with the Instagram permissions.',
    );
  return { ...c, mode, provider, callback: `${c.base}/v1/facebook/instagram/oauth/callback` };
}

export class InstagramService {
  constructor(
    private database: Knex = db,
    private meta: FacebookGraph = graph,
    private direct: InstagramGraph = directGraph,
  ) {}

  async access(s: FacebookScope) {
    if (s.reviewPageId) fail('Use your company owner login for Instagram.', 403);
    await new FacebookMessengerService(this.database, this.meta).access(s, 'manage');
  }

  async start(s: FacebookScope, provider?: string) {
    await this.access(s);
    const c = instagramConfig(provider),
      state = random(),
      browser = random();
    await this.database('instagram_oauth_sessions').where('expires_at', '<', new Date()).delete();
    await this.database('instagram_oauth_sessions').insert({
      state_hash: hash(state),
      browser_hash: hash(browser),
      company_id: s.companyId,
      owner_id: s.ownerId,
      auth_provider: c.provider,
      provider_app_id: c.appId,
      redirect_uri: c.callback,
      expires_at: new Date(Date.now() + 15 * 60000),
    });
    const url = new URL(
      c.provider === 'instagram'
        ? 'https://www.instagram.com/oauth/authorize'
        : `https://www.facebook.com/${c.version}/dialog/oauth`,
    );
    const params: Record<string, string> = {
      client_id: c.appId,
      redirect_uri: c.callback,
      state,
      response_type: 'code',
    };
    if (c.provider === 'instagram') {
      params.scope = directInstagramLoginScopes.join(',');
      params.enable_fb_login = '0';
      params.force_authentication = '1';
    } else if (c.mode === 'classic') {
      params.scope = instagramPermissions.join(',');
      params.auth_type = 'rerequest';
    } else {
      params.config_id = process.env.INSTAGRAM_LOGIN_CONFIG_ID!;
      params.override_default_response_type = 'true';
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { browser, url: url.toString() };
  }

  async discover(token: string) {
    const pages: any[] = [];
    let after: string | undefined;
    for (let i = 0; i < 100; i++) {
      const response = await this.meta.call('me/accounts', token, 'GET', {
        fields: 'id,name,access_token,tasks,instagram_business_account{id,username}',
        limit: 100,
        ...(after ? { after } : {}),
      });
      if (!Array.isArray(response.data)) fail('Meta returned an invalid Page list.', 502);
      pages.push(
        ...response.data.filter(
          (p: any) =>
            numeric(p.id) &&
            numeric(p.instagram_business_account?.id) &&
            p.access_token &&
            (p.tasks || []).some((t: string) => ['MESSAGING', 'MESSAGE', 'PROFILE_PLUS_MESSAGING'].includes(t)),
        ),
      );
      if (!response.paging?.next) {
        if (!pages.length)
          fail(
            'No eligible linked Instagram accounts. Link a professional Instagram account to your Facebook Page and grant your Facebook user Page messaging access.',
            403,
          );
        return pages;
      }
      const next = this.cursor(response.paging.cursors?.after);
      if (!next || next === after) break;
      after = next;
    }
    return fail('Meta Page pagination did not complete.', 502);
  }

  async callback(state: unknown, browser: string | undefined, code: unknown, cancelled: boolean) {
    if (typeof state !== 'string' || !browser) fail('Instagram login session is missing. Connect again.', 403);
    const [session] = await this.database('instagram_oauth_sessions')
      .where({ state_hash: hash(state as string), browser_hash: hash(browser!), status: 'started' })
      .where('expires_at', '>', new Date())
      .update({ status: 'authorizing' })
      .returning('*');
    if (!session) fail('Instagram login session expired or was already used.', 403);
    try {
      await this.access({ companyId: session.company_id, ownerId: session.owner_id, userId: session.owner_id });
      const provider = session.auth_provider || 'facebook';
      const c = instagramConfig(provider);
      if (session.provider_app_id && session.provider_app_id !== c.appId)
        fail('The app configuration changed during login. Connect again.', 409);
      if (session.redirect_uri && session.redirect_uri !== c.callback)
        fail('The callback URL changed during login. Connect again.', 409);
      if (cancelled) fail('Authorization was cancelled.');
      if (typeof code !== 'string' || !code) fail('Facebook did not return an authorization code.');
      if (provider === 'instagram') {
        const auth = await this.direct.authorize(code as string, c.callback);
        if (auth.granted) {
          const missing = directInstagramPermissions.filter((p) => !auth.granted!.includes(p));
          if (missing.length)
            fail(`Missing permissions: ${missing.join(', ')}. Reconnect and grant Instagram access.`, 403);
        }
        await this.database('instagram_oauth_sessions')
          .where({ state_hash: session.state_hash })
          .update({
            status: 'ready',
            provider_user_id: auth.userId,
            candidates_ciphertext: encrypt(
              JSON.stringify({
                pages: [
                  {
                    id: auth.profile.id,
                    name: null,
                    access_token: auth.token,
                    instagram_business_account: { id: auth.profile.id, username: auth.profile.username },
                  },
                ],
                expires: auth.expires,
                granted: auth.granted,
                dataExpires: null,
              }),
            ),
          });
        return 'ready';
      }
      const auth = await this.meta.authorize(code as string, c.callback);
      const missing = instagramPermissions.filter((p) => !auth.granted.includes(p));
      if (missing.length)
        fail(`Missing permissions: ${missing.join(', ')}. Reconnect and grant Instagram access.`, 403);
      const pages = await this.discover(auth.token);
      await this.database('instagram_oauth_sessions')
        .where({ state_hash: session.state_hash, status: 'authorizing' })
        .update({
          status: 'ready',
          facebook_user_id: auth.userId,
          candidates_ciphertext: encrypt(JSON.stringify({ pages, dataExpires: auth.dataExpires })),
        });
      return 'ready';
    } catch (e) {
      await this.database('instagram_oauth_sessions')
        .where({ state_hash: session.state_hash })
        .update({
          status: 'failed',
          candidates_ciphertext: null,
          error: e instanceof FacebookError ? e.message : 'Instagram authorization failed. Connect again.',
        });
      return 'failed';
    }
  }

  async session(s: FacebookScope, browser?: string) {
    await this.access(s);
    if (!browser) return null;
    return this.database('instagram_oauth_sessions')
      .where({ company_id: s.companyId, owner_id: s.ownerId, browser_hash: hash(browser) })
      .where('expires_at', '>', new Date())
      .first();
  }

  async candidates(s: FacebookScope, browser?: string) {
    const session = await this.session(s, browser);
    const pages = session?.status === 'ready' ? JSON.parse(decrypt(session.candidates_ciphertext)).pages : [];
    return {
      status: session?.status || 'none',
      error: session?.error || null,
      pages: pages.map((p: any) => ({
        selection_id: p.id,
        auth_provider: session.auth_provider || 'facebook',
        page_id: session.auth_provider === 'instagram' ? null : p.id,
        page_name: p.name,
        instagram_id: p.instagram_business_account.id,
        username: p.instagram_business_account.username || '',
      })),
    };
  }

  async connect(s: FacebookScope, browser: string | undefined, pageId: unknown) {
    const session = await this.session(s, browser);
    if (!numeric(pageId) || session?.status !== 'ready') fail('Choose a Page from a fresh Instagram connection.');
    return this.database.transaction(async (trx) => {
      const current = await trx('instagram_oauth_sessions')
        .where({ state_hash: session.state_hash })
        .forUpdate()
        .first();
      if (current?.status !== 'ready' || new Date(current.expires_at).getTime() <= Date.now())
        fail('Connect again; this selection expired.', 409);
      const data = JSON.parse(decrypt(current.candidates_ciphertext));
      const p = data.pages.find((p: any) => p.id === pageId);
      if (!p) fail('This Page was not authorized.', 403);
      if (current.auth_provider === 'instagram') return this.connectDirect(trx, s, current, data, p);
      const igId = p.instagram_business_account.id;
      // Share the Page lock with the existing Messenger/lead integrations.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`facebook-page:${pageId}`]);
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`instagram:${igId}`]);
      const existing = await trx('instagram_accounts').where({ instagram_id: igId }).forUpdate().first();
      for (const table of ['facebook_pages', 'facebook_lead_pages', 'facebook_content_pages']) {
        const other = await trx(table).where({ page_id: p.id }).first();
        if (other && (other.company_id !== s.companyId || other.owner_id !== s.ownerId))
          fail('This Page is connected to another workspace.', 409);
      }
      if (existing && (existing.company_id !== s.companyId || existing.owner_id !== s.ownerId))
        fail('This Instagram account belongs to another workspace.', 409);
      const inspected = await this.meta.inspectPage(p.id, p.access_token);
      if ([inspected.expires, data.dataExpires].some((v) => v && new Date(v).getTime() <= Date.now()))
        fail('Authorization expired. Connect again.', 409);
      const profile = await this.meta.call(p.id, p.access_token, 'GET', {
        fields: 'id,instagram_business_account{id,username}',
      });
      if (profile.instagram_business_account?.id !== igId)
        fail('The linked Instagram account changed. Connect again.', 409);
      // FB Login subscribes the linked Page. Preserve all existing Page fields,
      // including leadgen; Instagram comments are selected on the app's Instagram object.
      const before = await this.meta.call(`${p.id}/subscribed_apps`, p.access_token);
      const app = (before.data || []).find((a: any) => String(a.id) === config('transport').appId);
      const fields = [...new Set<string>([...(app?.subscribed_fields || []), 'messages'])];
      await this.meta.call(
        `${p.id}/subscribed_apps`,
        p.access_token,
        'POST',
        {},
        { subscribed_fields: fields.join(',') },
      );
      const after = await this.meta.call(`${p.id}/subscribed_apps`, p.access_token);
      if (
        !(after.data || []).some(
          (a: any) => String(a.id) === config('transport').appId && (a.subscribed_fields || []).includes('messages'),
        )
      )
        fail('Meta did not confirm the Page message subscription. Check the app webhook setup.', 502);
      const values = {
        company_id: s.companyId,
        owner_id: s.ownerId,
        instagram_id: igId,
        page_id: p.id,
        page_name: p.name,
        username: profile.instagram_business_account.username || p.instagram_business_account.username || igId,
        facebook_user_id: current.facebook_user_id,
        auth_provider: 'facebook',
        provider_app_id: current.provider_app_id || config('transport').appId,
        provider_user_id: current.facebook_user_id,
        token_ciphertext: encrypt(p.access_token),
        token_expires_at: inspected.expires,
        data_access_expires_at: data.dataExpires,
        status: 'connected',
        connected_at: new Date(),
      };
      const [account] = existing
        ? await trx('instagram_accounts').where({ id: existing.id }).update(values).returning(publicFields)
        : await trx('instagram_accounts').insert(values).returning(publicFields);
      await trx('instagram_oauth_sessions')
        .where({ state_hash: current.state_hash })
        .update({ status: 'completed', candidates_ciphertext: null });
      return account;
    });
  }

  private async connectDirect(trx: Knex.Transaction, s: FacebookScope, session: any, data: any, candidate: any) {
    const c = instagramConfig('instagram');
    if (session.provider_app_id !== c.appId) fail('The Instagram app changed. Connect again.', 409);
    const profile = await this.direct.profile(candidate.access_token);
    if (profile.id !== candidate.instagram_business_account.id)
      fail('The Instagram account changed. Connect again.', 409);
    const expires = new Date(data.expires);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())
      fail('Instagram authorization expired. Connect again.', 409);
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`instagram:${profile.id}`]);
    const existing = await trx('instagram_accounts').where({ instagram_id: profile.id }).forUpdate().first();
    if (existing && (existing.company_id !== s.companyId || existing.owner_id !== s.ownerId))
      fail('This Instagram account belongs to another workspace.', 409);
    const subscribed = await this.direct.call(
      'me/subscribed_apps',
      candidate.access_token,
      'POST',
      {},
      { subscribed_fields: 'messages,comments' },
    );
    if (subscribed.success !== true) fail('Instagram did not confirm webhook subscription.', 502);
    const after = await this.direct.call('me/subscribed_apps', candidate.access_token);
    // Instagram returns a subscription identifier here, which can differ from
    // the OAuth client ID. This endpoint is scoped to the authorized token;
    // app identity was already bound and checked on the OAuth session above.
    if (
      !Array.isArray(after.data) ||
      !after.data.some(
        (app: any) =>
          Array.isArray(app.subscribed_fields) &&
          ['messages', 'comments'].every((field) => app.subscribed_fields.includes(field)),
      )
    )
      fail('Instagram webhook subscription could not be verified. Configure messages and comments in Meta.', 502);
    const values = {
      company_id: s.companyId,
      owner_id: s.ownerId,
      instagram_id: profile.id,
      username: profile.username,
      page_id: null,
      page_name: null,
      facebook_user_id: null,
      auth_provider: 'instagram',
      provider_app_id: c.appId,
      provider_user_id: session.provider_user_id,
      token_ciphertext: encrypt(candidate.access_token),
      token_expires_at: expires,
      data_access_expires_at: null,
      token_refreshed_at: new Date(),
      granted_permissions: Array.isArray(data.granted) ? JSON.stringify(data.granted) : null,
      status: 'connected',
      connected_at: new Date(),
    };
    const [account] = existing
      ? await trx('instagram_accounts').where({ id: existing.id }).update(values).returning(publicFields)
      : await trx('instagram_accounts').insert(values).returning(publicFields);
    await trx('instagram_oauth_sessions')
      .where({ state_hash: session.state_hash })
      .update({ status: 'completed', candidates_ciphertext: null });
    return account;
  }

  private api(account: any) {
    return account.auth_provider === 'instagram' ? this.direct : this.meta;
  }

  async accounts(s: FacebookScope) {
    await this.access(s);
    await scoped(this.database, s)
      .where({ status: 'connected' })
      .where((q) => q.where('token_expires_at', '<=', new Date()).orWhere('data_access_expires_at', '<=', new Date()))
      .update({ status: 'reconnect_required' });
    return scoped(this.database, s).select(publicFields).orderBy('username');
  }
  async account(s: FacebookScope, id: string, connected = true) {
    await this.access(s);
    if (!uuidPattern.test(id)) fail('Invalid account ID.');
    const account = await scoped(this.database, s).where({ id }).first();
    if (!account) fail('Instagram account not found in this workspace.', 404);
    if (connected) {
      this.assertConnected(account);
      if (account.auth_provider === 'instagram') {
        if (account.provider_app_id !== instagramConfig('instagram').appId)
          fail('The Instagram app changed. Reconnect this account.', 409);
        if (
          new Date(account.token_expires_at).getTime() <= Date.now() + 7 * 86400000 &&
          new Date(account.token_refreshed_at || 0).getTime() <= Date.now() - 86400000
        ) {
          return this.database.transaction(async (trx) => {
            const current = await scoped(trx, s).where({ id }).forUpdate().first();
            if (!current) fail('Instagram account was removed.', 409);
            this.assertConnected(current);
            if (
              new Date(current.token_expires_at).getTime() > Date.now() + 7 * 86400000 ||
              new Date(current.token_refreshed_at || 0).getTime() > Date.now() - 86400000
            )
              return current;
            const renewed = await this.direct.refresh(decrypt(current.token_ciphertext));
            const [updated] = await scoped(trx, s)
              .where({ id })
              .update({
                token_ciphertext: encrypt(renewed.token),
                token_expires_at: renewed.expires,
                token_refreshed_at: new Date(),
              })
              .returning('*');
            return updated;
          });
        }
      }
    }
    return account;
  }
  async syncProfile(s: FacebookScope, id: string) {
    const authorized = await this.account(s, id);
    return this.database.transaction(async (trx) => {
      const current = await scoped(trx, s).where({ id }).forUpdate().first();
      if (!current) fail('Instagram account was removed.', 404);
      this.assertConnected(current);
      if (current.auth_provider !== authorized.auth_provider || current.provider_app_id !== authorized.provider_app_id)
        fail('The connection changed. Reload the account.', 409);
      let profile: { id: string; username: string };
      if (current.auth_provider === 'instagram') {
        profile = await this.direct.profile(decrypt(current.token_ciphertext));
      } else {
        const result = await this.meta.call(current.page_id, decrypt(current.token_ciphertext), 'GET', {
          fields: 'id,instagram_business_account{id,username}',
        });
        profile = result.instagram_business_account;
      }
      if (profile?.id !== current.instagram_id)
        fail('The Instagram account changed. Reconnect before refreshing this profile.', 409);
      if (typeof profile.username !== 'string' || !profile.username || profile.username.length > 100)
        fail('Instagram did not return a valid username.', 502);
      const [updated] = await scoped(trx, s)
        .where({ id })
        .update({ username: profile.username })
        .returning(publicFields);
      return updated;
    });
  }
  assertConnected(a: any) {
    if (a.status !== 'connected' || !a.token_ciphertext) fail('Reconnect this Instagram account.', 409);
    if ([a.token_expires_at, a.data_access_expires_at].some((v) => v && new Date(v).getTime() <= Date.now()))
      fail('Instagram authorization expired. Reconnect.', 409);
  }
  cursor(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value))
      fail('Invalid pagination cursor.');
    return value as string;
  }
  async put(
    trx: Knex,
    account: string,
    kind: string,
    remote: string,
    parent: string | null,
    payload: any,
    time = new Date(),
  ) {
    if (typeof remote !== 'string' || !remote || remote.length > 200) fail('Meta returned an invalid object ID.', 502);
    await trx('instagram_records')
      .insert({
        account_id: account,
        kind,
        remote_id: remote,
        parent_id: parent,
        payload: JSON.stringify(payload),
        event_at: time,
      })
      .onConflict(['account_id', 'kind', 'remote_id'])
      .merge(['parent_id', 'payload', 'event_at']);
  }
  async record(a: any, id: string, kind: string) {
    if (!uuidPattern.test(id)) fail('Invalid resource ID.');
    const record = await this.database('instagram_records').where({ id, account_id: a.id, kind }).first();
    if (!record) fail('Resource not found in this Instagram account.', 404);
    return record;
  }
  async list(s: FacebookScope, id: string, kind: 'conversation' | 'media' | 'message' | 'comment', parent?: string) {
    const a = await this.account(s, id, false);
    const query = this.database('instagram_records').where({ account_id: a.id, kind });
    if (parent) query.where({ parent_id: parent });
    return query.orderBy('event_at', 'desc').limit(100);
  }

  async sync(
    s: FacebookScope,
    id: string,
    kind: 'conversation' | 'media' | 'message' | 'comment',
    parentId?: string,
    cursor?: unknown,
  ) {
    const a = await this.account(s, id),
      token = decrypt(a.token_ciphertext),
      after = this.cursor(cursor);
    let path: string,
      fields: string,
      params: any = {},
      parent: any;
    if (kind === 'conversation') {
      path = `${a.auth_provider === 'instagram' ? a.instagram_id : a.page_id}/conversations`;
      fields = 'id,participants,updated_time';
      params.platform = 'instagram';
    } else if (kind === 'media') {
      path = `${a.instagram_id}/media`;
      fields = 'id,caption,media_type,permalink,timestamp';
    } else {
      parent = await this.record(a, parentId || '', kind === 'message' ? 'conversation' : 'media');
      if (kind === 'message' && !parent.payload.thread_id) return { next_cursor: null };
      path = `${kind === 'message' ? parent.payload.thread_id : parent.remote_id}/${kind === 'message' ? 'messages' : 'comments'}`;
      fields = kind === 'message' ? 'id,message,from,to,created_time' : 'id,text,username,timestamp,hidden';
    }
    const response = await this.api(a).call(path, token, 'GET', {
      ...params,
      fields,
      // Expanded participant data can fail on larger Instagram conversation
      // batches even when the same cursor works with a smaller page.
      limit: kind === 'conversation' && a.auth_provider === 'instagram' ? 10 : 50,
      ...(after ? { after } : {}),
    });
    if (!Array.isArray(response.data)) fail('Meta returned an invalid list.', 502);
    await this.database.transaction(async (trx) => {
      const current = await scoped(trx, s).where({ id }).forUpdate().first();
      if (!current) fail('Instagram account was removed.', 409);
      this.assertConnected(current);
      for (const row of response.data) {
        if (kind === 'conversation') {
          const peer = (row.participants?.data || []).find(
            (p: any) => numeric(p.id) && ![a.instagram_id, a.page_id].includes(p.id),
          );
          if (peer)
            await this.put(
              trx,
              id,
              kind,
              peer.id,
              null,
              { thread_id: row.id, username: peer.username || peer.name || peer.id },
              date(row.updated_time) || new Date(),
            );
        } else if (kind === 'message') {
          const time = date(row.created_time);
          if (!time || !numeric(row.from?.id)) continue;
          const incoming = row.from.id === parent.remote_id;
          if (!incoming && ![a.instagram_id, a.page_id].includes(row.from.id)) continue;
          await this.put(trx, id, kind, row.id, parent.remote_id, { text: row.message || '', incoming }, time);
        } else
          await this.put(
            trx,
            id,
            kind,
            row.id,
            parent?.remote_id || null,
            kind === 'media'
              ? { caption: row.caption || '', media_type: row.media_type || '', permalink: row.permalink || '' }
              : { text: row.text || '', username: row.username || '', hidden: Boolean(row.hidden) },
            date(row.timestamp) || new Date(),
          );
      }
    });
    const next = response.paging?.next ? this.cursor(response.paging.cursors?.after) : null;
    if (response.paging?.next && (!next || next === after)) fail('Meta pagination did not advance.', 502);
    return { next_cursor: next || null };
  }

  async messages(s: FacebookScope, id: string, conversation: string) {
    const a = await this.account(s, id, false),
      row = await this.record(a, conversation, 'conversation');
    const messages = await this.list(s, id, 'message', row.remote_id);
    const incoming = await this.database('instagram_records')
      .where({ account_id: id, kind: 'message', parent_id: row.remote_id })
      .whereRaw("payload->>'incoming' = 'true'")
      .orderBy('event_at', 'desc')
      .first();
    const end = incoming ? new Date(incoming.event_at).getTime() + 86400000 : 0;
    return {
      messages,
      can_reply:
        a.status === 'connected' &&
        Boolean(a.token_ciphertext) &&
        end > Date.now() &&
        ![a.token_expires_at, a.data_access_expires_at].some((v) => v && new Date(v).getTime() <= Date.now()),
      reply_window_ends_at: end ? new Date(end).toISOString() : null,
    };
  }

  async comments(s: FacebookScope, id: string, media: string) {
    const a = await this.account(s, id, false),
      row = await this.record(a, media, 'media');
    return this.list(s, id, 'comment', row.remote_id);
  }

  async action(
    s: FacebookScope,
    id: string,
    targetId: string,
    type: 'message' | 'reply' | 'hide',
    input: unknown,
    requestId: unknown,
  ) {
    const a = await this.account(s, id);
    if (typeof requestId !== 'string' || !uuidPattern.test(requestId)) fail('Provide a UUID client_request_id.');
    if (
      type === 'hide' ? typeof input !== 'boolean' : typeof input !== 'string' || !input.trim() || input.length > 1000
    )
      fail(type === 'hide' ? 'Provide hidden: true or false.' : 'Enter a reply of 1 to 1000 characters.');
    const target = await this.record(a, targetId, type === 'message' ? 'conversation' : 'comment');
    const fingerprint = hash(JSON.stringify([targetId, type, input]));
    // Reserve before contacting Meta so concurrent requests and uncertain replies
    // cannot produce a second customer-facing message for the same request ID.
    const reserved = await this.database.transaction(async (trx) => {
      const current = await scoped(trx, s).where({ id }).forUpdate().first();
      if (!current) fail('Instagram account was removed.', 409);
      this.assertConnected(current);
      const old = await trx('instagram_actions').where({ account_id: id, request_id: requestId }).first();
      if (old) {
        if (old.fingerprint !== fingerprint) fail('This request ID was already used for another action.', 409);
        return { fresh: false, ...old };
      }
      if (type === 'message' && !(await this.messages(s, id, targetId)).can_reply)
        fail('The 24-hour reply window is closed. Ask the customer to send another Instagram DM.', 409);
      const [row] = await trx('instagram_actions')
        .insert({ account_id: id, request_id: requestId, fingerprint })
        .returning('*');
      return { fresh: true, ...row };
    });
    if (!reserved.fresh) return { status: reserved.status, ...(reserved.result || {}) };
    const path =
      type === 'message'
        ? `${a.auth_provider === 'instagram' ? a.instagram_id : a.page_id}/messages`
        : type === 'reply'
          ? `${target.remote_id}/replies`
          : target.remote_id;
    const body =
      type === 'message'
        ? {
            recipient: { id: target.remote_id },
            message: { text: (input as string).trim() },
            ...(a.auth_provider === 'instagram' ? {} : { messaging_type: 'RESPONSE' }),
          }
        : type === 'reply'
          ? { message: (input as string).trim() }
          : { hide: input };
    try {
      return await this.database.transaction(async (trx) => {
        const current = await scoped(trx, s).where({ id }).forUpdate().first();
        if (!current) fail('The integration was removed before this action.', 409);
        this.assertConnected(current);
        if (current.auth_provider !== a.auth_provider || current.provider_app_id !== a.provider_app_id)
          fail('The Instagram connection changed. Reload the account before sending.', 409);
        // Serialize the external action with disconnect/revoke. The separately
        // committed reservation survives a timeout or rolled-back transaction.
        const result = await this.api(current).call(path, decrypt(current.token_ciphertext), 'POST', {}, body);
        if (type === 'message' ? !result.message_id : type === 'reply' ? !result.id : result.success !== true)
          fail('Meta did not confirm this action. Check Instagram before trying again.', 502);
        if (type === 'message')
          await this.put(trx, id, 'message', result.message_id, target.remote_id, {
            text: (input as string).trim(),
            incoming: false,
          });
        if (type === 'hide')
          await trx('instagram_records')
            .where({ id: target.id })
            .update({ payload: JSON.stringify({ ...target.payload, hidden: input }) });
        await trx('instagram_actions')
          .where({ id: reserved.id })
          .update({
            status: 'confirmed',
            result: JSON.stringify({ remote_id: result.message_id || result.id || target.remote_id }),
          });
        return { status: 'confirmed', remote_id: result.message_id || result.id || target.remote_id };
      });
    } catch (e) {
      await this.database('instagram_actions').where({ id: reserved.id }).update({ status: 'unconfirmed' });
      if (e instanceof FacebookError && e.status < 500) throw e;
      throw new FacebookError(
        502,
        'The action was not confirmed. Check Instagram before trying again. This request ID will not be sent twice.',
        'META_UNCONFIRMED',
      );
    }
  }

  async receive(body: any, provider: 'instagram' | 'facebook' = 'facebook') {
    if (body?.object !== 'instagram' || !Array.isArray(body.entry)) return;
    for (const entry of body.entry) {
      if (!numeric(entry.id)) continue;
      await this.database.transaction(async (trx) => {
        const a = await trx('instagram_accounts')
          .where({ instagram_id: entry.id, status: 'connected', auth_provider: provider })
          .forUpdate()
          .first();
        if (!a?.token_ciphertext) return;
        if ([a.token_expires_at, a.data_access_expires_at].some((v) => v && new Date(v).getTime() <= Date.now()))
          return;
        for (const event of entry.messaging || []) {
          if (!event.message?.mid || event.message.is_deleted) continue;
          const incoming = event.recipient?.id === a.instagram_id && event.sender?.id !== a.instagram_id;
          const outgoing = event.sender?.id === a.instagram_id;
          const peer = incoming ? event.sender?.id : outgoing ? event.recipient?.id : null;
          const time = date(event.timestamp);
          if (!numeric(peer) || !time) continue;
          await trx('instagram_records')
            .insert({
              account_id: a.id,
              kind: 'conversation',
              remote_id: peer,
              payload: JSON.stringify({ username: peer }),
              event_at: time,
            })
            .onConflict(['account_id', 'kind', 'remote_id'])
            .ignore();
          await this.put(
            trx,
            a.id,
            'message',
            event.message.mid,
            peer,
            { incoming, text: typeof event.message.text === 'string' ? event.message.text : '[Instagram attachment]' },
            time,
          );
        }
        for (const change of entry.changes || []) {
          const v = change.value;
          if (change.field !== 'comments' || !numeric(v?.id) || !numeric(v?.media?.id)) continue;
          // Unknown posts are listed by Refresh posts; known posts show new comments immediately.
          const media = await trx('instagram_records')
            .where({ account_id: a.id, kind: 'media', remote_id: v.media.id })
            .first();
          if (media)
            await this.put(
              trx,
              a.id,
              'comment',
              v.id,
              v.media.id,
              { text: v.text || '', username: v.from?.username || '', hidden: false },
              date(Number(entry.time) * 1000) || new Date(),
            );
        }
      });
    }
  }

  async disconnect(s: FacebookScope, id: string, erase = false) {
    await this.account(s, id, false);
    await this.database.transaction(async (trx) => {
      const row = await scoped(trx, s).where({ id }).forUpdate().first();
      if (!row) fail('Instagram account not found.', 404);
      // The linked Page subscription is shared with Messenger and Lead Forms.
      // Stop processing locally without removing another integration's subscription.
      if (erase) await trx('instagram_accounts').where({ id }).delete();
      else await trx('instagram_accounts').where({ id }).update({ status: 'disconnected', token_ciphertext: null });
      await trx('instagram_oauth_sessions').where({ company_id: s.companyId, owner_id: s.ownerId }).delete();
    });
    return { disconnected: true, deleted: erase };
  }
  async revoke(user: string, erase: boolean, provider: 'instagram' | 'facebook' = 'facebook') {
    return this.database.transaction(async (trx) => {
      const userField = provider === 'instagram' ? 'provider_user_id' : 'facebook_user_id';
      const rows = await trx('instagram_accounts')
        .where({ [userField]: user, auth_provider: provider })
        .forUpdate()
        .select('id');
      if (erase)
        await trx('instagram_accounts')
          .whereIn(
            'id',
            rows.map((r) => r.id),
          )
          .delete();
      else
        await trx('instagram_accounts')
          .whereIn(
            'id',
            rows.map((r) => r.id),
          )
          .update({ status: 'reconnect_required', token_ciphertext: null });
      await trx('instagram_oauth_sessions')
        .where({ [userField]: user, auth_provider: provider })
        .delete();
      if (erase && provider === 'instagram') {
        const confirmation = random();
        await trx('facebook_deletion_requests').insert({ confirmation_hash: hash(confirmation), status: 'completed' });
        return confirmation;
      }
      return null;
    });
  }
}
export default new InstagramService();
