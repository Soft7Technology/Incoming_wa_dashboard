import { Knex } from 'knex';
import db from '@surefy/database';
import graph, { FacebookGraph } from './facebookGraph.service';
import { FacebookMessengerService, FacebookScope } from './facebookMessenger.service';
import { config, decrypt, encrypt, FacebookError, hash, random, uuidPattern } from '../utils/facebook';

export const contentPermissions = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
];
const pageFields = ['id', 'page_id', 'name', 'status', 'connected_at'];
const scoped = (db: Knex, s: FacebookScope) =>
  db('facebook_content_pages').where({ company_id: s.companyId, owner_id: s.ownerId });
function fail(message: string, status = 400): never {
  throw new FacebookError(status, message);
}
const metaId = (id: unknown): id is string => typeof id === 'string' && /^\d{1,80}$/.test(id);
const safeError = (e: unknown) =>
  e instanceof FacebookError
    ? e.message
    : 'Facebook could not complete the operation. Details were suppressed to protect credentials.';
const postFields = 'id,message,created_time,permalink_url,from{id,name}';
const permalink = (v: unknown) => (typeof v === 'string' && /^https:\/\/(www\.)?facebook\.com\//.test(v) ? v : null);
const date = (v: unknown) => {
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? new Date(n) : new Date();
};
export function contentConfig(requireLogin = true) {
  const c = config('transport');
  const mode = process.env.FACEBOOK_PAGES_LOGIN_MODE || process.env.FACEBOOK_LOGIN_MODE || 'business';
  if (!['business', 'classic'].includes(mode)) fail('Set FACEBOOK_PAGES_LOGIN_MODE to business or classic.', 503);
  const loginConfig = mode === 'business' ? process.env.FACEBOOK_PAGES_LOGIN_CONFIG_ID : null;
  if (requireLogin && mode === 'business' && !/^\d{1,80}$/.test(loginConfig || ''))
    fail(
      'Set FACEBOOK_PAGES_LOGIN_CONFIG_ID to a Facebook Login for Business configuration with the four Page posts permissions.',
      503,
    );
  return { ...c, mode, loginConfig, callback: `${c.base}/v1/facebook/posts/oauth/callback` };
}

export class FacebookContentService {
  constructor(
    private database: Knex = db,
    private meta: FacebookGraph = graph,
  ) {}
  async access(s: FacebookScope) {
    if (s.reviewPageId) fail('Use the application owner login for Page posts.', 403);
    await new FacebookMessengerService(this.database, this.meta).access(s, 'manage');
  }
  async start(s: FacebookScope) {
    await this.access(s);
    const c = contentConfig(),
      state = random(),
      browser = random();
    await this.database('facebook_content_oauth').where('expires_at', '<', new Date()).delete();
    await this.database('facebook_content_oauth').insert({
      state_hash: hash(state),
      browser_hash: hash(browser),
      company_id: s.companyId,
      owner_id: s.ownerId,
      app_id: c.appId,
      redirect_uri: c.callback,
      login_config_id: c.loginConfig,
      status: 'started',
      expires_at: new Date(Date.now() + 900000),
    });
    const url = new URL(`https://www.facebook.com/${c.version}/dialog/oauth`);
    const params: Record<string, string> = {
      client_id: c.appId,
      redirect_uri: c.callback,
      response_type: 'code',
      state,
    };
    if (c.mode === 'classic') {
      params.scope = contentPermissions.join(',');
      params.auth_type = 'rerequest';
    } else {
      params.config_id = c.loginConfig!;
      params.override_default_response_type = 'true';
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { browser, url: url.toString() };
  }
  private checkGrants(granted: string[]) {
    const missing = contentPermissions.filter((p) => !granted.includes(p));
    if (missing.length)
      fail(`Missing permissions: ${missing.join(', ')}. Connect again and grant Page posts access.`, 403);
  }
  private async selection(token: string, granted: string[], dataExpires: any) {
    this.checkGrants(granted);
    const pages = await this.meta.pages(token, 'leads');
    return { pages, granted, dataExpires };
  }
  async importToken(s: FacebookScope, input: unknown) {
    await this.access(s);
    const c = contentConfig(false);
    if (typeof input !== 'string' || !/^[A-Za-z0-9._-]{20,8192}$/.test(input.trim()))
      fail('Enter a valid Facebook USER access token.');
    const auth = await this.meta.inspectUser(input.trim());
    const data = await this.selection(input.trim(), auth.granted, auth.dataExpires);
    await this.access(s);
    const browser = random();
    await this.database('facebook_content_oauth').insert({
      state_hash: hash(random()),
      browser_hash: hash(browser),
      company_id: s.companyId,
      owner_id: s.ownerId,
      app_id: c.appId,
      redirect_uri: c.callback,
      status: 'ready',
      facebook_user_id: auth.userId,
      candidates_ciphertext: encrypt(JSON.stringify(data)),
      expires_at: new Date(Date.now() + 900000),
    });
    return { browser };
  }
  async callback(state: unknown, browser: string | undefined, code: unknown, cancelled: boolean) {
    if (typeof state !== 'string' || !browser) fail('Facebook login session is missing.', 403);
    const [session] = await this.database('facebook_content_oauth')
      .where({ state_hash: hash(state), browser_hash: hash(browser), status: 'started' })
      .where('expires_at', '>', new Date())
      .update({ status: 'authorizing' })
      .returning('*');
    if (!session) fail('Facebook login expired or was already used.', 403);
    try {
      const c = contentConfig();
      if (
        session.app_id !== c.appId ||
        session.redirect_uri !== c.callback ||
        (session.login_config_id || null) !== (c.loginConfig || null)
      )
        fail('Facebook app configuration changed. Connect again.', 409);
      await this.access({ companyId: session.company_id, ownerId: session.owner_id, userId: session.owner_id });
      if (cancelled) fail('Facebook login was cancelled.');
      if (typeof code !== 'string' || !code) fail('Facebook did not return an authorization code.');
      const auth = await this.meta.authorize(code, c.callback);
      const data = await this.selection(auth.token, auth.granted, auth.dataExpires);
      await this.database('facebook_content_oauth')
        .where({ state_hash: session.state_hash })
        .update({
          status: 'ready',
          facebook_user_id: auth.userId,
          candidates_ciphertext: encrypt(JSON.stringify(data)),
        });
      return 'ready';
    } catch (e) {
      await this.database('facebook_content_oauth')
        .where({ state_hash: session.state_hash })
        .update({ status: 'failed', candidates_ciphertext: null, error: safeError(e) });
      return 'failed';
    }
  }
  private async session(s: FacebookScope, browser?: string) {
    if (!browser) return null;
    return this.database('facebook_content_oauth')
      .where({ company_id: s.companyId, owner_id: s.ownerId, browser_hash: hash(browser) })
      .where('expires_at', '>', new Date())
      .orderBy('expires_at', 'desc')
      .first();
  }
  async candidates(s: FacebookScope, browser?: string) {
    await this.access(s);
    const session = await this.session(s, browser);
    const data = session?.status === 'ready' ? JSON.parse(decrypt(session.candidates_ciphertext)) : { pages: [] };
    return {
      status: session?.status || 'none',
      error: session?.error || null,
      pages: data.pages.map((p: any) => ({ page_id: String(p.id), name: p.name })),
    };
  }
  async connect(s: FacebookScope, browser: string | undefined, pageId: unknown) {
    await this.access(s);
    if (!metaId(pageId)) fail('Select a Facebook Page.');
    const pending = await this.session(s, browser);
    if (pending?.status !== 'ready') fail('Page selection expired. Connect again.', 409);
    const c = contentConfig(false);
    if (pending.app_id !== c.appId || pending.redirect_uri !== c.callback)
      fail('Facebook app changed. Connect again.', 409);
    return this.database.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`facebook-page:${pageId}`]);
      const session = await trx('facebook_content_oauth')
        .where({ state_hash: pending.state_hash, status: 'ready' })
        .where('expires_at', '>', new Date())
        .forUpdate()
        .first();
      if (!session) fail('Page selection expired or was already used.', 409);
      const data = JSON.parse(decrypt(session.candidates_ciphertext));
      this.checkGrants(data.granted);
      const selected = data.pages.find((p: any) => String(p.id) === pageId);
      if (!selected) fail('This Page was not selected in your Facebook authorization.', 403);
      for (const table of ['facebook_content_pages', 'facebook_pages', 'facebook_lead_pages', 'instagram_accounts']) {
        const other = await trx(table).where({ page_id: pageId }).first();
        if (other && (other.company_id !== s.companyId || other.owner_id !== s.ownerId))
          fail('This Page belongs to another workspace. Its owner must remove that connection first.', 409);
      }
      const checked = await this.meta.inspectPage(pageId, selected.access_token);
      this.checkGrants(checked.granted);
      if ([checked.expires, data.dataExpires].some((v) => v && new Date(v).getTime() <= Date.now()))
        fail('Facebook authorization expired. Connect again.', 409);
      const profile = await this.meta.call(pageId, selected.access_token, 'GET', { fields: 'id,name' });
      if (String(profile.id) !== pageId) fail('Facebook returned a different Page.', 502);
      const existing = await trx('facebook_content_pages').where({ page_id: pageId }).forUpdate().first();
      const values = {
        company_id: s.companyId,
        owner_id: s.ownerId,
        page_id: pageId,
        name: profile.name || selected.name,
        facebook_user_id: session.facebook_user_id,
        app_id: c.appId,
        token_ciphertext: encrypt(selected.access_token),
        granted_permissions: JSON.stringify(checked.granted),
        token_expires_at: checked.expires,
        data_access_expires_at: data.dataExpires,
        status: 'connected',
        connected_at: new Date(),
      };
      const [page] = existing
        ? await trx('facebook_content_pages').where({ id: existing.id }).update(values).returning(pageFields)
        : await trx('facebook_content_pages').insert(values).returning(pageFields);
      await trx('facebook_content_oauth')
        .where({ state_hash: pending.state_hash })
        .update({ status: 'completed', candidates_ciphertext: null });
      return page;
    });
  }
  async pages(s: FacebookScope) {
    await this.access(s);
    await scoped(this.database, s)
      .where({ status: 'connected' })
      .where((q) => q.where('token_expires_at', '<=', new Date()).orWhere('data_access_expires_at', '<=', new Date()))
      .update({ status: 'reconnect_required' });
    return scoped(this.database, s).select(pageFields).orderBy('name');
  }
  private connected(page: any) {
    if (!page || page.status !== 'connected' || !page.token_ciphertext)
      fail('Reconnect this Page to read or publish content.', 409);
    if (page.app_id !== contentConfig(false).appId) fail('The Facebook app changed. Reconnect this Page.', 409);
    if ([page.token_expires_at, page.data_access_expires_at].some((v) => v && new Date(v).getTime() <= Date.now()))
      fail('Facebook authorization expired. Reconnect this Page.', 409);
    this.checkGrants(page.granted_permissions || []);
  }
  async page(s: FacebookScope, id: string, active = true) {
    await this.access(s);
    if (!uuidPattern.test(id)) fail('Invalid Page connection ID.');
    const page = await scoped(this.database, s).where({ id }).first();
    if (!page) fail('Page not found in your workspace.', 404);
    if (active) this.connected(page);
    return page;
  }
  private async post(s: FacebookScope, id: string, postId: string) {
    await this.page(s, id, false);
    if (!uuidPattern.test(postId)) fail('Invalid post ID.');
    const post = await this.database('facebook_content_posts').where({ id: postId, page_id: id }).first();
    if (!post) fail('Post not found on this Page.', 404);
    return post;
  }
  private cursor(value: unknown) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value))
      fail('Invalid pagination cursor.');
    return value;
  }
  async posts(s: FacebookScope, id: string) {
    await this.page(s, id, false);
    return this.database('facebook_content_posts').where({ page_id: id }).orderBy('created_at', 'desc').limit(100);
  }
  async comments(s: FacebookScope, id: string, postId: string) {
    await this.post(s, id, postId);
    return this.database('facebook_content_comments')
      .where({ post_id: postId })
      .orderBy('created_at', 'desc')
      .limit(100);
  }
  async sync(s: FacebookScope, id: string, postId?: string, after?: unknown) {
    const page = await this.page(s, id),
      post = postId ? await this.post(s, id, postId) : null;
    if (post?.deleted) fail('This post has been deleted.', 409);
    const response = await this.meta.call(
      post ? `${post.remote_id}/comments` : `${page.page_id}/feed`,
      decrypt(page.token_ciphertext),
      'GET',
      { fields: post ? 'id,message,created_time,from{id,name}' : postFields, limit: 25, after: this.cursor(after) },
    );
    if (!Array.isArray(response.data)) fail('Facebook returned an invalid content list.', 502);
    const next = response.paging?.next ? this.cursor(response.paging?.cursors?.after) : null;
    if (response.paging?.next && (!next || next === after)) fail('Facebook pagination did not advance.', 502);
    await this.database.transaction(async (trx) => {
      const current = await scoped(trx, s).where({ id }).forUpdate().first();
      this.connected(current);
      for (const item of response.data) {
        if (post) {
          if (typeof item.id !== 'string' || !/^\d{1,80}(?:_\d{1,80})?$/.test(item.id)) continue;
          await trx('facebook_content_comments')
            .insert({
              post_id: post.id,
              remote_id: item.id,
              message: typeof item.message === 'string' ? item.message : '',
              author_name: typeof item.from?.name === 'string' ? item.from.name.slice(0, 255) : null,
              created_at: date(item.created_time),
            })
            .onConflict(['post_id', 'remote_id'])
            .merge(['message', 'author_name']);
        } else {
          if (typeof item.id !== 'string' || !new RegExp(`^${page.page_id}_\\d{1,80}$`).test(item.id)) continue;
          await trx('facebook_content_posts')
            .insert({
              page_id: id,
              remote_id: item.id,
              message: typeof item.message === 'string' ? item.message : '',
              author_id: metaId(item.from?.id) ? item.from.id : null,
              author_name: typeof item.from?.name === 'string' ? item.from.name.slice(0, 255) : null,
              from_page: item.from?.id ? String(item.from.id) === page.page_id : null,
              permalink: permalink(item.permalink_url),
              created_at: date(item.created_time),
            })
            .onConflict(['page_id', 'remote_id'])
            .merge(['message', 'author_id', 'author_name', 'from_page', 'permalink']);
        }
      }
    });
    return { imported: response.data.length, next_cursor: next || null };
  }
  async actions(s: FacebookScope, id: string) {
    await this.page(s, id, false);
    return this.database('facebook_content_actions')
      .where({ page_id: id })
      .select('id', 'kind', 'status', 'result', 'error', 'created_at')
      .orderBy('created_at', 'desc')
      .limit(30);
  }
  private actionView(a: any) {
    return { id: a.id, status: a.status, result: a.result || null, error: a.error || null };
  }
  async action(s: FacebookScope, id: string, kind: 'create' | 'edit' | 'delete', input: any, postId?: string) {
    await this.page(s, id);
    if (!input || !uuidPattern.test(String(input.client_request_id || ''))) fail('Provide a UUID client_request_id.');
    const message = input.message ?? '',
      link = input.link ?? '';
    if (kind !== 'delete' && (typeof message !== 'string' || !message.trim() || Array.from(message).length > 5000))
      fail('Enter post text up to 5,000 characters.');
    if (typeof link !== 'string' || link.length > 4096) fail('Invalid link.');
    if (link) {
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        fail('Use an HTTPS link.');
      }
      if (url.protocol !== 'https:' || url.username || url.password)
        fail('Use an HTTPS link without embedded credentials.');
    }
    if (kind !== 'create' && link) fail('Links cannot be changed when editing a post.');
    const fingerprint = hash(JSON.stringify([kind, postId || null, message, link]));
    const previous = await this.database('facebook_content_actions')
      .where({ page_id: id, client_request_id: input.client_request_id })
      .first();
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('This request ID was used for a different action.', 409);
      return this.actionView(previous);
    }
    const target = postId ? await this.post(s, id, postId) : null;
    if (kind !== 'create' && (!target?.managed || target.deleted))
      fail('Only active posts created through this app can be edited or deleted.', 403);
    const reserved = await this.database.transaction(async (trx) => {
      const page = await scoped(trx, s).where({ id }).forUpdate().first();
      this.connected(page);
      const existing = await trx('facebook_content_actions')
        .where({ page_id: id, client_request_id: input.client_request_id })
        .first();
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('This request ID was used for a different action.', 409);
        return { ...existing, fresh: false };
      }
      const [a] = await trx('facebook_content_actions')
        .insert({ page_id: id, client_request_id: input.client_request_id, fingerprint, kind, status: 'pending' })
        .returning('*');
      return { ...a, fresh: true };
    });
    if (!reserved.fresh) return this.actionView(reserved);
    try {
      await this.database.transaction(async (trx) => {
        const page = await scoped(trx, s).where({ id }).forUpdate().first();
        this.connected(page);
        if (target) {
          const current = await trx('facebook_content_posts').where({ id: target.id, page_id: id }).forUpdate().first();
          if (!current?.managed || current.deleted) fail('This post can no longer be changed.', 409);
        }
        const response = await this.meta.call(
          kind === 'create' ? `${page.page_id}/feed` : target.remote_id,
          decrypt(page.token_ciphertext),
          kind === 'delete' ? 'DELETE' : 'POST',
          {},
          kind === 'delete' ? undefined : { message: message.trim(), ...(kind === 'create' && link ? { link } : {}) },
        );
        let result: any;
        if (kind === 'create') {
          if (typeof response.id !== 'string' || !new RegExp(`^${page.page_id}_\\d{1,80}$`).test(response.id))
            fail('Facebook did not confirm the created post.', 502);
          const [post] = await trx('facebook_content_posts')
            .insert({
              page_id: id,
              remote_id: response.id,
              message: message.trim(),
              from_page: true,
              author_id: page.page_id,
              author_name: page.name,
              managed: true,
            })
            .onConflict(['page_id', 'remote_id'])
            .merge(['message', 'managed', 'from_page', 'author_id', 'author_name'])
            .returning('id');
          result = { post_id: post.id, remote_id: response.id };
        } else {
          if (response.success !== true && response !== true) fail('Facebook did not confirm the post change.', 502);
          await trx('facebook_content_posts')
            .where({ id: target.id })
            .update(
              kind === 'delete'
                ? { deleted: true, updated_at: new Date() }
                : { message: message.trim(), updated_at: new Date() },
            );
          result = { post_id: target.id, remote_id: target.remote_id };
        }
        await trx('facebook_content_actions')
          .where({ id: reserved.id })
          .update({ status: 'confirmed', result: JSON.stringify(result) });
      });
    } catch (e) {
      await this.database('facebook_content_actions')
        .where({ id: reserved.id })
        .update({
          status: e instanceof FacebookError && e.status < 500 ? 'failed' : 'unconfirmed',
          error:
            e instanceof FacebookError && e.status < 500
              ? e.message
              : 'Facebook did not confirm this action. Check the Page before creating or repeating a post.',
        });
    }
    const saved = await this.database('facebook_content_actions').where({ id: reserved.id }).first();
    if (!saved) fail('The integration was removed.', 404);
    return this.actionView(saved);
  }
  async disconnect(s: FacebookScope, id: string, erase = false) {
    await this.page(s, id, false);
    await this.database.transaction(async (trx) => {
      const page = await scoped(trx, s).where({ id }).forUpdate().first();
      if (!page) fail('Page not found.', 404);
      if (erase) await trx('facebook_content_pages').where({ id }).delete();
      else await trx('facebook_content_pages').where({ id }).update({ token_ciphertext: null, status: 'disconnected' });
    });
    return { disconnected: true, deleted: erase };
  }
}
export default new FacebookContentService();
