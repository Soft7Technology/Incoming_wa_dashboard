import { Knex } from 'knex';
import { createHash } from 'crypto';
import db from '@surefy/database';
import { GooglePeopleClient } from './googlePeopleClient.service';
import {
  PeopleScope,
  PeopleOAuthClient,
  configuration,
  sharedClient,
  credentials,
  owner,
  nonce,
  hash,
  random,
  encrypt,
  decrypt,
  contactsScope,
  contactInput,
  contactResource,
  sourceEtag,
  fail,
} from '../utils/googlePeople';

const where = (s: PeopleScope) => ({ company_id: s.companyId, owner_id: s.ownerId });
export class GooglePeopleService {
  constructor(
    private database: Knex = db,
    private google: GooglePeopleClient = new GooglePeopleClient(),
  ) {}
  private async lock(trx: Knex.Transaction, scope: PeopleScope) {
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`google-people:${scope.companyId}:${scope.ownerId}`]);
  }
  private async active(trx: Knex | Knex.Transaction, scope: PeopleScope) {
    owner(scope);
    const user = await trx('users')
      .where({ id: scope.ownerId, company_id: scope.companyId, status: 'active' })
      .whereNull('deleted_at')
      .first();
    const company = await trx('companies')
      .where({ id: scope.companyId, status: 'active' })
      .whereNull('deleted_at')
      .first();
    if (!user || !company) fail(403, 'The Google Contacts account owner or company is inactive.');
  }
  private async client(scope: PeopleScope, trx: Knex | Knex.Transaction = this.database): Promise<PeopleOAuthClient> {
    const custom = await trx('google_people_oauth_apps').where(where(scope)).first();
    if (!custom) return sharedClient();
    return {
      clientId: custom.client_id,
      clientSecret: decrypt(custom.client_secret_ciphertext, scope),
      redirectUri: configuration().redirectUri,
      source: 'custom',
    };
  }
  async setup(scope: PeopleScope) {
    owner(scope);
    const config = configuration();
    const app = await this.database('google_people_oauth_apps').where(where(scope)).first('client_id');
    let ready = true,
      issue: string | null = null;
    try {
      await this.client(scope);
    } catch (error) {
      ready = false;
      issue = error instanceof Error ? error.message : 'Configure Google Contacts.';
    }
    return {
      ready,
      issue,
      redirect_uri: config.redirectUri,
      scope: contactsScope,
      custom_client: Boolean(app),
      client_id: app?.client_id || null,
      login_domain: process.env.GOOGLE_TEST_LOGIN_DOMAIN || (process.env.NODE_ENV !== 'production' ? 'localhost' : ''),
    };
  }
  async saveApp(scope: PeopleScope, body: any) {
    owner(scope);
    configuration();
    const client = credentials(body?.client_id, body?.client_secret);
    return this.database.transaction(async (trx) => {
      await this.lock(trx, scope);
      await this.active(trx, scope);
      const record = {
        ...where(scope),
        client_id: client.clientId,
        client_secret_ciphertext: encrypt(client.clientSecret, scope),
        updated_at: new Date(),
      };
      await trx('google_people_oauth_apps').insert(record).onConflict(['company_id', 'owner_id']).merge(record);
      // Never use a previous app's refresh token with newly supplied credentials.
      await trx('google_people_oauth_sessions').where(where(scope)).delete();
      await trx('google_people_connections').where(where(scope)).delete();
      return { saved: true, reconnect_required: true, redirect_uri: configuration().redirectUri };
    });
  }
  async removeApp(scope: PeopleScope) {
    owner(scope);
    return this.database.transaction(async (trx) => {
      await this.lock(trx, scope);
      await this.active(trx, scope);
      for (const table of ['google_people_oauth_sessions', 'google_people_connections', 'google_people_oauth_apps'])
        await trx(table).where(where(scope)).delete();
      return { removed: true, reconnect_required: true };
    });
  }
  async start(scope: PeopleScope) {
    owner(scope);
    return this.database.transaction(async (trx) => {
      await this.lock(trx, scope);
      await this.active(trx, scope);
      const client = await this.client(scope, trx),
        state = random(),
        browser = random(),
        verifier = random();
      await trx('google_people_oauth_sessions').where('expires_at', '<', new Date()).delete();
      await trx('google_people_oauth_sessions').insert({
        ...where(scope),
        state_hash: hash(state),
        browser_hash: hash(browser),
        verifier_ciphertext: encrypt(verifier, scope),
        client_context_ciphertext: encrypt(JSON.stringify(client), scope),
        expires_at: new Date(Date.now() + 600000),
      });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      Object.entries({
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        response_type: 'code',
        scope: contactsScope,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }).forEach(([k, v]) => url.searchParams.set(k, v));
      return { browser, authorization_url: url.toString() };
    });
  }
  async callback(state: unknown, browser: unknown, code: unknown, denied: boolean) {
    if (!nonce(state) || !nonce(browser))
      fail(400, 'Invalid Google Contacts browser session. Start Connect Google Contacts again.');
    const [session] = await this.database('google_people_oauth_sessions')
      .where({ state_hash: hash(state as string), browser_hash: hash(browser as string) })
      .whereNull('consumed_at')
      .where('expires_at', '>', new Date())
      .update({ consumed_at: new Date() })
      .returning('*');
    if (!session) fail(400, 'Google Contacts authorization expired, was cancelled or was already used.');
    if (denied) {
      await this.database('google_people_oauth_sessions').where({ state_hash: session.state_hash }).delete();
      return { connected: false };
    }
    if (typeof code !== 'string' || !code || code.length > 4096) return fail(400, 'Missing Google authorization code.');
    const scope = { companyId: session.company_id, ownerId: session.owner_id, userId: session.owner_id };
    const client = JSON.parse(decrypt(session.client_context_ciphertext, scope)) as PeopleOAuthClient;
    const tokens = await this.google.exchange(code, decrypt(session.verifier_ciphertext, scope), client);
    const access = this.tokenValues(tokens);
    if (
      !String(tokens.scope || '')
        .split(/\s+/)
        .includes(contactsScope) ||
      typeof tokens.refresh_token !== 'string' ||
      !tokens.refresh_token ||
      tokens.refresh_token.length > 16384
    )
      fail(403, 'Google Contacts permission and offline access are required.');
    return this.database.transaction(async (trx) => {
      await this.lock(trx, scope);
      await this.active(trx, scope);
      if (!(await trx('google_people_oauth_sessions').where({ state_hash: session.state_hash }).first()))
        fail(409, 'The Google Contacts connection was cancelled. Start again.');
      const record = {
        ...where(scope),
        client_context_ciphertext: session.client_context_ciphertext,
        access_token_ciphertext: encrypt(access.token, scope),
        refresh_token_ciphertext: encrypt(tokens.refresh_token, scope),
        token_expires_at: access.expiry,
        scopes: JSON.stringify([contactsScope]),
        updated_at: new Date(),
      };
      await trx('google_people_connections').insert(record).onConflict(['company_id', 'owner_id']).merge(record);
      await trx('google_people_oauth_sessions').where({ state_hash: session.state_hash }).delete();
      return { connected: true };
    });
  }
  private tokenValues(tokens: any) {
    const seconds = Number(tokens?.expires_in);
    if (
      typeof tokens?.access_token !== 'string' ||
      !tokens.access_token ||
      tokens.access_token.length > 16384 ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > 86400
    )
      fail(502, 'Google returned invalid contact credentials.');
    return { token: tokens.access_token as string, expiry: new Date(Date.now() + seconds * 1000) };
  }
  async connection(scope: PeopleScope) {
    owner(scope);
    const row = await this.database('google_people_connections')
      .where(where(scope))
      .first('id', 'scopes', 'created_at', 'updated_at');
    return { connected: Boolean(row), connection: row || null };
  }
  async disconnect(scope: PeopleScope) {
    owner(scope);
    return this.database.transaction(async (trx) => {
      await this.lock(trx, scope);
      await this.active(trx, scope);
      await trx('google_people_oauth_sessions').where(where(scope)).delete();
      await trx('google_people_connections').where(where(scope)).delete();
      return { disconnected: true };
    });
  }
  private async withToken(scope: PeopleScope, operation: (token: string) => Promise<any>) {
    owner(scope);
    const outcome = await this.database.transaction(async (trx) => {
      // Serialize contact mutations across replicas and use the same lock for disconnect/config changes.
      await this.lock(trx, scope);
      await this.active(trx, scope);
      const row = await trx('google_people_connections').where(where(scope)).forUpdate().first();
      if (!row) fail(409, 'Connect Google Contacts before managing contacts.');
      if (!row.scopes.includes(contactsScope))
        fail(403, 'Reconnect Google Contacts and approve the contacts permission.');
      let token = decrypt(row.access_token_ciphertext, scope);
      if (new Date(row.token_expires_at).getTime() <= Date.now() + 60000) {
        const client = JSON.parse(decrypt(row.client_context_ciphertext, scope));
        const refreshed = await this.google.refresh(decrypt(row.refresh_token_ciphertext, scope), client);
        const access = this.tokenValues(refreshed);
        if (refreshed.scope && !String(refreshed.scope).split(/\s+/).includes(contactsScope))
          fail(403, 'Google Contacts permission was removed. Reconnect.');
        if (
          refreshed.refresh_token !== undefined &&
          (typeof refreshed.refresh_token !== 'string' ||
            !refreshed.refresh_token ||
            refreshed.refresh_token.length > 16384)
        )
          fail(502, 'Google returned an invalid refresh credential.');
        token = access.token;
        await trx('google_people_connections')
          .where({ id: row.id })
          .update({
            access_token_ciphertext: encrypt(token, scope),
            token_expires_at: access.expiry,
            updated_at: new Date(),
            ...(refreshed.refresh_token ? { refresh_token_ciphertext: encrypt(refreshed.refresh_token, scope) } : {}),
          });
      }
      // Preserve rotated credentials even if the later read/write fails. Do not retry writes here.
      try {
        return { value: await operation(token) };
      } catch (error) {
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async list(scope: PeopleScope, query: any = {}) {
    const pageSize = Number(query.page_size ?? 50),
      pageToken = query.page_token;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail(400, 'page_size must be from 1 to 100.');
    if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 4096))
      fail(400, 'Invalid page_token.');
    return this.withToken(scope, (token) => this.google.list(token, pageSize, pageToken));
  }
  async get(scope: PeopleScope, input: unknown) {
    const resource = contactResource(input);
    return this.withToken(scope, (token) => this.google.get(token, resource));
  }
  async createContact(scope: PeopleScope, body: any) {
    const person = contactInput(body);
    return this.withToken(scope, (token) => this.google.create(token, person));
  }
  async updateContact(scope: PeopleScope, input: unknown, body: any) {
    const resource = contactResource(input),
      etag = sourceEtag(body?.source_etag),
      changes = contactInput(body, true);
    return this.withToken(scope, async (token) => {
      const current = await this.google.get(token, resource);
      const source = current.metadata?.sources?.find((s: any) => s.type === 'CONTACT');
      if (!source?.id || !source.etag) fail(400, 'Only contact-based Google People records can be edited.');
      if (source.etag !== etag) fail(409, 'This Google contact changed since you read it. Reload it before saving.');
      return this.google.update(
        token,
        resource,
        {
          resourceName: resource,
          ...(current.etag ? { etag: current.etag } : {}),
          metadata: { sources: [{ type: 'CONTACT', id: source.id, etag: source.etag }] },
          ...changes,
        },
        Object.keys(changes),
      );
    });
  }
}
export default new GooglePeopleService();
