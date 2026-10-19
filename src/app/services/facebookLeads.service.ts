import { Knex } from 'knex';
import db from '@surefy/database';
import graph, { FacebookGraph } from './facebookGraph.service';
import { FacebookMessengerService, FacebookScope } from './facebookMessenger.service';
import {
  config,
  decrypt,
  encrypt,
  FacebookError,
  hash,
  leadPermissions,
  random,
  subscriptions,
  uuidPattern,
} from '../utils/facebook';

const pageFields = [
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
const failure = (error: unknown) =>
  error instanceof FacebookError ? error : new FacebookError(500, 'Facebook lead operation failed. Please try again.');
const metaId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,80}$/.test(value);
const scoped = (database: Knex, scope: FacebookScope) =>
  database('facebook_lead_pages').where({ company_id: scope.companyId, owner_id: scope.ownerId });

export class FacebookLeadsService {
  constructor(
    private database: Knex = db,
    private meta: FacebookGraph = graph,
  ) {}

  async access(scope: FacebookScope) {
    if (scope.reviewPageId) throw new FacebookError(403, 'Use a company owner login for the Lead Forms workspace.');
    await new FacebookMessengerService(this.database, this.meta).access(scope, 'manage');
  }

  presetAvailable(scope: FacebookScope) {
    return (
      !scope.reviewPageId &&
      scope.userId === scope.ownerId &&
      scope.ownerId === process.env.FACEBOOK_LEADS_PRESET_OWNER_ID &&
      scope.companyId === process.env.FACEBOOK_LEADS_PRESET_COMPANY_ID &&
      metaId(process.env.FACEBOOK_LEADS_PRESET_PAGE_ID) &&
      Boolean(process.env.FACEBOOK_LEADS_PRESET_TOKEN_CIPHERTEXT)
    );
  }

  async connectPreset(scope: FacebookScope) {
    await this.access(scope);
    if (!this.presetAvailable(scope))
      throw new FacebookError(403, 'A saved Facebook connection is not configured for your account.');
    const pageId = process.env.FACEBOOK_LEADS_PRESET_PAGE_ID!;
    const token = decrypt(process.env.FACEBOOK_LEADS_PRESET_TOKEN_CIPHERTEXT!);
    const imported = await this.importToken(scope, token, pageId);
    try {
      return await this.connect(scope, imported.browser, pageId);
    } finally {
      await this.database('facebook_lead_oauth_sessions')
        .where({ browser_hash: hash(imported.browser), company_id: scope.companyId, owner_id: scope.ownerId })
        .delete();
    }
  }

  async choosePresetPages(scope: FacebookScope) {
    await this.access(scope);
    if (!this.presetAvailable(scope))
      throw new FacebookError(403, 'A saved Facebook connection is not configured for your account.');
    // The saved Page shortcut stays restricted to its configured Page. Explicit
    // selection can use all Pages granted to this owner's saved user token.
    return this.importToken(scope, decrypt(process.env.FACEBOOK_LEADS_PRESET_TOKEN_CIPHERTEXT!));
  }

  async start(scope: FacebookScope) {
    await this.access(scope);
    const c = config('leads'),
      state = random(),
      browser = random();
    await this.database('facebook_lead_oauth_sessions').where('expires_at', '<', new Date()).delete();
    await this.database('facebook_lead_oauth_sessions').insert({
      state_hash: hash(state),
      browser_hash: hash(browser),
      company_id: scope.companyId,
      owner_id: scope.ownerId,
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
    });
    const url = new URL(`https://www.facebook.com/${c.version}/dialog/oauth`);
    const params: Record<string, string> = {
      client_id: c.appId,
      redirect_uri: `${c.base}/v1/facebook/leads/oauth/callback`,
      state,
      response_type: 'code',
    };
    if (process.env.FACEBOOK_LOGIN_MODE === 'classic') {
      params.scope = leadPermissions.join(',');
      params.auth_type = 'rerequest';
    } else {
      params.config_id = process.env.FACEBOOK_LEADS_LOGIN_CONFIG_ID!;
      params.override_default_response_type = 'true';
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { browser, url: url.toString() };
  }

  async importToken(scope: FacebookScope, input: unknown, restrictPageId?: string) {
    await this.access(scope);
    config('transport');
    if (typeof input !== 'string' || !/^[A-Za-z0-9._-]{20,8192}$/.test(input.trim()))
      throw new FacebookError(400, 'Paste a valid Facebook user access token.');
    const token = input.trim();
    const auth = await this.meta.inspectUser(token);
    const missing = leadPermissions.filter((p) => !auth.granted.includes(p));
    if (missing.length)
      throw new FacebookError(
        403,
        `Missing Facebook permissions: ${missing.join(', ')}. Generate a token with the required lead permissions.`,
        'MISSING_PERMISSIONS',
      );
    const authorizedPages = await this.meta.pages(token, 'leads');
    const pages = restrictPageId
      ? authorizedPages.filter((p: any) => String(p.id) === restrictPageId)
      : authorizedPages;
    if (!pages.length)
      throw new FacebookError(403, 'No authorized Pages found. Check Page access and assets selected for this token.');
    await this.access(scope);
    const browser = random();
    await this.database.transaction(async (trx) => {
      await trx('facebook_lead_oauth_sessions').where('expires_at', '<', new Date()).delete();
      await trx('facebook_lead_oauth_sessions').insert({
        state_hash: hash(random()),
        browser_hash: hash(browser),
        company_id: scope.companyId,
        owner_id: scope.ownerId,
        facebook_user_id: auth.userId,
        status: 'ready',
        candidates_ciphertext: encrypt(JSON.stringify({ pages, dataExpires: auth.dataExpires })),
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
      });
    });
    // Keep only encrypted Page candidates for selection. Do not retain or return
    // the pasted user token, and never return Page credentials to the browser.
    return { browser };
  }

  async callback(state: unknown, browser: string | undefined, code: unknown, cancelled: boolean) {
    if (typeof state !== 'string' || !browser)
      throw new FacebookError(403, 'Facebook login session is missing. Connect again.');
    const [session] = await this.database('facebook_lead_oauth_sessions')
      .where({ state_hash: hash(state), browser_hash: hash(browser), status: 'started' })
      .where('expires_at', '>', new Date())
      .update({ status: 'authorizing' })
      .returning('*');
    if (!session) throw new FacebookError(403, 'Facebook login session expired or was already used.');
    try {
      await this.access({ companyId: session.company_id, ownerId: session.owner_id, userId: session.owner_id });
      if (cancelled) throw new FacebookError(400, 'Facebook login was cancelled.');
      if (typeof code !== 'string' || !code)
        throw new FacebookError(400, 'Facebook did not return an authorization code.');
      const auth = await this.meta.authorize(code, `${config('leads').base}/v1/facebook/leads/oauth/callback`);
      const missing = leadPermissions.filter((p) => !auth.granted.includes(p));
      if (missing.length)
        throw new FacebookError(
          403,
          `Missing Facebook permissions: ${missing.join(', ')}. Reconnect and grant access.`,
          'MISSING_PERMISSIONS',
        );
      const pages = await this.meta.pages(auth.token, 'leads');
      if (!pages.length)
        throw new FacebookError(403, 'No authorized Pages found. Check the Pages selected in Facebook consent.');
      await this.database('facebook_lead_oauth_sessions')
        .where({ state_hash: session.state_hash })
        .update({
          status: 'ready',
          facebook_user_id: auth.userId,
          candidates_ciphertext: encrypt(JSON.stringify({ pages, dataExpires: auth.dataExpires })),
        });
      return 'ready';
    } catch (error) {
      await this.database('facebook_lead_oauth_sessions')
        .where({ state_hash: session.state_hash })
        .update({ status: 'failed', error: failure(error).message, candidates_ciphertext: null });
      return 'failed';
    }
  }

  async session(scope: FacebookScope, browser: string | undefined) {
    if (!browser) return null;
    return this.database('facebook_lead_oauth_sessions')
      .where({ browser_hash: hash(browser), company_id: scope.companyId, owner_id: scope.ownerId })
      .where('expires_at', '>', new Date())
      .first();
  }

  async candidates(scope: FacebookScope, browser: string | undefined) {
    await this.access(scope);
    const session = await this.session(scope, browser);
    const payload =
      session?.status === 'ready' && session.candidates_ciphertext
        ? JSON.parse(decrypt(session.candidates_ciphertext))
        : { pages: [] };
    return {
      status: session?.status || 'none',
      error: session?.error || null,
      pages: payload.pages.map((p: any) => ({ page_id: String(p.id), name: p.name })),
    };
  }

  async connect(scope: FacebookScope, browser: string | undefined, pageId: unknown) {
    await this.access(scope);
    if (!metaId(pageId)) throw new FacebookError(400, 'Select a Facebook Page.');
    const session = await this.session(scope, browser);
    if (session?.status !== 'ready' || !session.candidates_ciphertext)
      throw new FacebookError(409, 'Page selection expired. Connect again.');
    const payload = JSON.parse(decrypt(session.candidates_ciphertext));
    const candidate = payload.pages.find((p: any) => String(p.id) === pageId);
    if (!candidate?.access_token) throw new FacebookError(403, 'This Page was not authorized in your current login.');
    const details = await this.meta.inspectPage(pageId, candidate.access_token);
    // This also exercises pages_read_engagement with a real Page metadata read.
    const metadata = await this.meta.call(pageId, candidate.access_token, 'GET', { fields: 'id,name' });
    if (String(metadata.id) !== pageId || typeof metadata.name !== 'string')
      throw new FacebookError(502, 'Meta did not return the selected Page.');
    return this.database.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`facebook-page:${pageId}`]);
      const instagram = await trx('instagram_accounts').where({ page_id: pageId }).first();
      if (instagram && (instagram.company_id !== scope.companyId || instagram.owner_id !== scope.ownerId))
        throw new FacebookError(409, 'This Page is linked to an Instagram integration in another workspace.');
      const existing = await trx('facebook_lead_pages').where({ page_id: pageId }).forUpdate().first();
      const messenger = await trx('facebook_pages').where({ page_id: pageId }).first();
      const content = await trx('facebook_content_pages').where({ page_id: pageId }).first();
      for (const connected of [existing, messenger, content]) {
        if (connected && (connected.company_id !== scope.companyId || connected.owner_id !== scope.ownerId))
          throw new FacebookError(
            409,
            'This Page is connected to another account. Delete its stored integration before transferring it.',
          );
      }
      const active = await trx('facebook_lead_oauth_sessions')
        .where({ state_hash: session.state_hash, status: 'ready' })
        .where('expires_at', '>', new Date())
        .forUpdate()
        .first();
      if (!active) throw new FacebookError(409, 'Page selection expired or was already used.');
      let fields = ['leadgen'];
      let subscriptionToken = candidate.access_token;
      let status = 'connected',
        error: string | null = null;
      try {
        if (messenger?.status === 'connected' && messenger.token_ciphertext) {
          if (details.granted.includes('pages_messaging')) {
            fields = [...subscriptions, 'leadgen'];
          } else {
            let messengerGrants: string[] = [];
            try {
              messengerGrants = (await this.meta.inspectPage(pageId, decrypt(messenger.token_ciphertext))).granted;
            } catch (e) {
              if (!(e instanceof FacebookError) || e.code !== 'TOKEN_EXPIRED') throw e;
            }
            if (!messengerGrants.includes('pages_messaging')) {
              await trx('facebook_pages').where({ id: messenger.id }).update({
                status: 'reconnect_required',
                error:
                  'Facebook authorization no longer grants pages_messaging. Reconnect Messenger to restore its webhooks.',
                updated_at: new Date(),
              });
            } else if (
              messengerGrants.includes('leads_retrieval') &&
              messengerGrants.includes('pages_manage_metadata')
            ) {
              fields = [...subscriptions, 'leadgen'];
              subscriptionToken = decrypt(messenger.token_ciphertext);
            } else {
              throw new FacebookError(
                409,
                'Keep Messenger connected by authorizing one Page token with both pages_messaging and the lead permissions, then reconnect.',
              );
            }
          }
        }
        const result = await this.meta.call(
          `${pageId}/subscribed_apps`,
          subscriptionToken,
          'POST',
          {},
          {
            subscribed_fields: [
              ...new Set([...fields, ...(instagram?.status === 'connected' ? ['messages'] : [])]),
            ].join(','),
          },
        );
        if (result.success !== true) throw new FacebookError(502, 'Meta did not confirm subscription.');
        const check = await this.meta.call(`${pageId}/subscribed_apps`, candidate.access_token, 'GET', {
          fields: 'id,subscribed_fields',
        });
        const app = check.data?.find((a: any) => String(a.id) === config('transport').appId);
        if (!app?.subscribed_fields?.includes('leadgen'))
          throw new FacebookError(
            502,
            'Lead webhook subscription could not be verified. Configure the Page leadgen field and reconnect.',
          );
      } catch (e) {
        status = 'subscription_failed';
        error = failure(e).message;
      }
      const values = {
        company_id: scope.companyId,
        owner_id: scope.ownerId,
        page_id: pageId,
        name: metadata.name,
        facebook_user_id: session.facebook_user_id,
        token_ciphertext: encrypt(candidate.access_token),
        token_expires_at: details.expires,
        data_access_expires_at: payload.dataExpires,
        status,
        error,
        updated_at: new Date(),
        connected_at: status === 'connected' ? new Date() : existing?.connected_at || null,
      };
      const [page] = existing
        ? await trx('facebook_lead_pages').where({ id: existing.id }).update(values).returning(pageFields)
        : await trx('facebook_lead_pages').insert(values).returning(pageFields);
      await trx('facebook_lead_oauth_sessions')
        .where({ state_hash: session.state_hash })
        .update({ status: 'completed', candidates_ciphertext: null });
      return page;
    });
  }

  async pages(scope: FacebookScope) {
    await this.access(scope);
    await scoped(this.database, scope)
      .where({ status: 'connected' })
      .where((q) => q.where('token_expires_at', '<=', new Date()).orWhere('data_access_expires_at', '<=', new Date()))
      .update({
        status: 'reconnect_required',
        error: 'Facebook authorization expired. Reconnect.',
        updated_at: new Date(),
      });
    return scoped(this.database, scope).select(pageFields).orderBy('name');
  }

  validateId(id: string) {
    if (!uuidPattern.test(id)) throw new FacebookError(400, 'Invalid resource ID.');
  }
  assertConnected(page: any) {
    if (!page || page.status !== 'connected' || !page.token_ciphertext)
      throw new FacebookError(409, 'Page is not connected. Reconnect it first.');
    if (
      [page.token_expires_at, page.data_access_expires_at].some(
        (date) => date && new Date(date).getTime() <= Date.now(),
      )
    )
      throw new FacebookError(409, 'Facebook authorization expired. Reconnect.', 'TOKEN_EXPIRED');
  }
  async page(scope: FacebookScope, id: string) {
    await this.access(scope);
    this.validateId(id);
    const page = await scoped(this.database, scope).where({ id }).first();
    if (!page) throw new FacebookError(404, 'Page not found in your account.');
    return page;
  }
  cursor(after: unknown) {
    if (after === undefined || after === null || after === '') return undefined;
    if (typeof after !== 'string' || after.length > 4096 || /[\x00-\x1f]/.test(after))
      throw new FacebookError(400, 'Invalid pagination cursor.');
    return after;
  }
  next(response: any, after?: string) {
    if (!response.paging?.next) return null;
    const next = this.cursor(response.paging.cursors?.after);
    if (!next || next === after) throw new FacebookError(502, 'Meta pagination did not advance. Retry the sync.');
    return next;
  }

  async forms(scope: FacebookScope, id: string, after?: unknown) {
    const page = await this.page(scope, id);
    this.assertConnected(page);
    const cursor = this.cursor(after);
    const response = await this.meta.call(`${page.page_id}/leadgen_forms`, decrypt(page.token_ciphertext), 'GET', {
      fields: 'id,name,status,questions',
      limit: 100,
      ...(cursor ? { after: cursor } : {}),
    });
    if (!Array.isArray(response.data)) throw new FacebookError(502, 'Meta returned an invalid form list.');
    await this.database.transaction(async (trx) => {
      const current = await scoped(trx, scope).where({ id }).forUpdate().first();
      this.assertConnected(current);
      for (const form of response.data) {
        if (!metaId(form.id) || typeof form.name !== 'string')
          throw new FacebookError(502, 'Meta returned an invalid lead form.');
        const values = {
          page_connection_id: id,
          form_id: form.id,
          name: form.name,
          status: form.status || null,
          questions: JSON.stringify(form.questions || []),
        };
        await trx('facebook_lead_forms')
          .insert(values)
          .onConflict(['page_connection_id', 'form_id'])
          .merge(['name', 'status', 'questions']);
      }
    });
    return {
      forms: await this.database('facebook_lead_forms').where({ page_connection_id: id }).orderBy('name'),
      next_cursor: this.next(response, cursor),
    };
  }

  async form(scope: FacebookScope, id: string) {
    await this.access(scope);
    this.validateId(id);
    const form = await this.database('facebook_lead_forms').where({ id }).first();
    if (!form) throw new FacebookError(404, 'Form not found in your account.');
    const page = await this.page(scope, form.page_connection_id);
    return { form, page };
  }
  async enable(scope: FacebookScope, id: string, enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new FacebookError(400, 'Provide enabled: true or false.');
    const { page } = await this.form(scope, id);
    return this.database.transaction(async (trx) => {
      const current = await scoped(trx, scope).where({ id: page.id }).forUpdate().first();
      if (enabled) this.assertConnected(current);
      const [form] = await trx('facebook_lead_forms').where({ id }).update({ enabled }).returning('*');
      return form;
    });
  }

  async persist(trx: Knex.Transaction, form: any, lead: any) {
    if (
      !metaId(lead.id) ||
      (lead.form_id && String(lead.form_id) !== form.form_id) ||
      !Array.isArray(lead.field_data) ||
      !Number.isFinite(Date.parse(lead.created_time))
    )
      throw new FacebookError(502, 'Meta returned invalid lead data.');
    const fieldData = lead.field_data.map((field: any) => {
      if (
        typeof field.name !== 'string' ||
        !Array.isArray(field.values) ||
        !field.values.every((v: unknown) => typeof v === 'string')
      )
        throw new FacebookError(502, 'Meta returned invalid lead answers.');
      return { name: field.name, values: field.values };
    });
    const rows = await trx('facebook_leads')
      .insert({
        form_connection_id: form.id,
        lead_id: lead.id,
        field_data: JSON.stringify(fieldData),
        submitted_at: new Date(lead.created_time),
      })
      .onConflict(['form_connection_id', 'lead_id'])
      .ignore()
      .returning('id');
    return rows.length;
  }

  async sync(scope: FacebookScope, id: string, after?: unknown) {
    const { form, page } = await this.form(scope, id);
    this.assertConnected(page);
    if (!form.enabled) throw new FacebookError(409, 'Enable syncing for this form first.');
    const cursor = this.cursor(after);
    try {
      const response = await this.meta.call(`${form.form_id}/leads`, decrypt(page.token_ciphertext), 'GET', {
        fields: 'id,created_time,form_id,field_data',
        limit: 100,
        ...(cursor ? { after: cursor } : {}),
      });
      if (!Array.isArray(response.data)) throw new FacebookError(502, 'Meta returned an invalid lead list.');
      const next = this.next(response, cursor);
      const imported = await this.database.transaction(async (trx) => {
        const current = await scoped(trx, scope).where({ id: page.id }).forUpdate().first();
        this.assertConnected(current);
        const currentForm = await trx('facebook_lead_forms').where({ id, enabled: true }).first();
        if (!currentForm) throw new FacebookError(409, 'Form syncing was disabled.');
        let count = 0;
        for (const lead of response.data) count += await this.persist(trx, currentForm, lead);
        await trx('facebook_lead_forms')
          .where({ id })
          .update({ sync_error: null, ...(!next ? { last_synced_at: new Date() } : {}) });
        return count;
      });
      return { imported, fetched: response.data.length, next_cursor: next };
    } catch (e) {
      const error = failure(e);
      await this.database('facebook_lead_forms').where({ id }).update({ sync_error: error.message });
      throw error;
    }
  }

  async leads(scope: FacebookScope, id: string, before?: unknown) {
    await this.form(scope, id);
    const query = this.database('facebook_leads').where({ form_connection_id: id });
    if (before) {
      if (typeof before !== 'string' || !uuidPattern.test(before)) throw new FacebookError(400, 'Invalid lead cursor.');
      const previous = await this.database('facebook_leads').where({ id: before, form_connection_id: id }).first();
      if (!previous) throw new FacebookError(400, 'Lead cursor not found for this form.');
      query.whereRaw('(submitted_at, id) < (?, ?)', [previous.submitted_at, previous.id]);
    }
    const rows = await query.orderBy('submitted_at', 'desc').orderBy('id', 'desc').limit(101);
    return { leads: rows.slice(0, 100), next_cursor: rows.length > 100 ? rows[99].id : null };
  }

  async receive(payload: any) {
    if (payload?.object !== 'page' || !Array.isArray(payload.entry)) return;
    for (const entry of payload.entry) {
      if (!metaId(String(entry.id)) || !Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        const value = change.value;
        if (
          change.field !== 'leadgen' ||
          !metaId(value?.leadgen_id) ||
          !metaId(value?.form_id) ||
          String(value?.page_id) !== String(entry.id)
        )
          continue;
        const page = await this.database('facebook_lead_pages')
          .where({ page_id: String(entry.id), status: 'connected' })
          .first();
        if (!page?.token_ciphertext) continue;
        const form = await this.database('facebook_lead_forms')
          .where({ page_connection_id: page.id, form_id: value.form_id, enabled: true })
          .first();
        if (!form) continue;
        // Recheck live account access before reading personal data.
        await this.access({ companyId: page.company_id, ownerId: page.owner_id, userId: page.owner_id });
        this.assertConnected(page);
        if (
          await this.database('facebook_leads')
            .where({ form_connection_id: form.id, lead_id: value.leadgen_id })
            .first('id')
        )
          continue;
        try {
          const lead = await this.meta.call(value.leadgen_id, decrypt(page.token_ciphertext), 'GET', {
            fields: 'id,created_time,form_id,field_data',
          });
          if (String(lead.id) !== value.leadgen_id || String(lead.form_id) !== form.form_id)
            throw new FacebookError(502, 'Meta lead does not match the webhook form.');
          await this.database.transaction(async (trx) => {
            const current = await trx('facebook_lead_pages')
              .where({ id: page.id, status: 'connected' })
              .forUpdate()
              .first();
            const enabled = await trx('facebook_lead_forms').where({ id: form.id, enabled: true }).first();
            if (!current?.token_ciphertext || !enabled) return;
            await this.persist(trx, enabled, lead);
            await trx('facebook_lead_forms')
              .where({ id: form.id })
              .update({ last_synced_at: new Date(), sync_error: null });
          });
        } catch (e) {
          const error = failure(e);
          await this.database('facebook_lead_forms').where({ id: form.id }).update({ sync_error: error.message });
          // A non-2xx response lets Meta redeliver. Manual sync also recovers missed leads.
          throw new FacebookError(503, error.message, error.code);
        }
      }
    }
  }

  async disconnect(scope: FacebookScope, id: string, erase = false) {
    const selected = await this.page(scope, id);
    return this.database.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`facebook-page:${selected.page_id}`]);
      const page = await scoped(trx, scope).where({ id }).forUpdate().first();
      if (!page) throw new FacebookError(404, 'Page not found in your account.');
      let warning: string | null = null;
      const instagram = await trx('instagram_accounts')
        .where({ page_id: page.page_id, status: 'connected' })
        .whereNotNull('token_ciphertext')
        .first();
      if (page.token_ciphertext && !instagram) {
        try {
          const messenger = await trx('facebook_pages').where({ page_id: page.page_id, status: 'connected' }).first();
          const result = messenger?.token_ciphertext
            ? await this.meta.call(
                `${page.page_id}/subscribed_apps`,
                decrypt(messenger.token_ciphertext),
                'POST',
                {},
                { subscribed_fields: subscriptions.join(',') },
              )
            : await this.meta.call(`${page.page_id}/subscribed_apps`, decrypt(page.token_ciphertext), 'DELETE');
          if (result.success !== true) throw new FacebookError(502, 'Meta did not confirm unsubscription.');
        } catch {
          warning = 'Disconnected locally. Meta unsubscription could not be confirmed.';
        }
      }
      await trx('facebook_lead_oauth_sessions')
        .where({ company_id: scope.companyId, owner_id: scope.ownerId })
        .delete();
      if (erase) await trx('facebook_lead_pages').where({ id }).delete();
      else
        await trx('facebook_lead_pages')
          .where({ id })
          .update({ token_ciphertext: null, status: 'disconnected', error: warning, updated_at: new Date() });
      return { disconnected: true, deleted: erase, warning };
    });
  }

  async revoke(facebookUserId: string, erase: boolean) {
    const pages = await this.database('facebook_lead_pages').where({ facebook_user_id: facebookUserId });
    for (const selected of pages) {
      await this.database.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`facebook-page:${selected.page_id}`]);
        const page = await trx('facebook_lead_pages')
          .where({ id: selected.id, facebook_user_id: facebookUserId })
          .forUpdate()
          .first();
        if (!page) return;
        // Signed lifecycle callbacks work even for suspended accounts. Retain
        // Messenger when a different Facebook person authorized that feature.
        const instagram = await trx('instagram_accounts')
          .where({ page_id: page.page_id, status: 'connected' })
          .whereNot({ facebook_user_id: facebookUserId })
          .whereNotNull('token_ciphertext')
          .first();
        if (page.token_ciphertext && !instagram) {
          try {
            const messenger = await trx('facebook_pages')
              .where({ page_id: page.page_id, status: 'connected' })
              .whereNot({ facebook_user_id: facebookUserId })
              .first();
            if (messenger?.token_ciphertext)
              await this.meta.call(
                `${page.page_id}/subscribed_apps`,
                decrypt(messenger.token_ciphertext),
                'POST',
                {},
                { subscribed_fields: subscriptions.join(',') },
              );
            else await this.meta.call(`${page.page_id}/subscribed_apps`, decrypt(page.token_ciphertext), 'DELETE');
          } catch {
            /* Meta may already have revoked the token. Local removal proceeds. */
          }
        }
        if (erase) await trx('facebook_lead_pages').where({ id: page.id }).delete();
        else
          await trx('facebook_lead_pages').where({ id: page.id }).update({
            token_ciphertext: null,
            status: 'disconnected',
            error: 'Facebook authorization was removed. Reconnect to resume syncing.',
            updated_at: new Date(),
          });
      });
    }
    await this.database('facebook_lead_oauth_sessions').where({ facebook_user_id: facebookUserId }).delete();
  }
}
export default new FacebookLeadsService();
