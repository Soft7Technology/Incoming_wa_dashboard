import { createHash, randomBytes } from 'crypto';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import * as bcrypt from 'bcrypt';
import { Knex } from 'knex';
import db from '@surefy/database';
import { CustomError } from '@surefy/exceptions/CustomError';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
// Only signed, verified Gmail/Workspace claims establish current mailbox ownership.
const authoritativeEmail = (identity: TokenPayload, email: string) => identity.email_verified === true &&
  (email.endsWith('@gmail.com') || (typeof identity.hd === 'string' && identity.hd.trim().length > 0));
const fail = (status: number, code: string, message: string): never => {
  throw new CustomError(message, status, true, { code });
};

export function googleAuthConfig(origin?: string) {
  // Explicit opt-in; never silently use integration credentials for authentication.
  const clientId = process.env.GOOGLE_AUTH_CLIENT_ID?.trim();
  const origins = (process.env.GOOGLE_AUTH_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!clientId || !origins.length) fail(503, 'GOOGLE_AUTH_NOT_CONFIGURED', 'Google sign-in is not configured.');
  let url: URL;
  try { url = new URL(origin || ''); } catch { return fail(403, 'GOOGLE_ORIGIN_NOT_ALLOWED', 'This dashboard is not enabled for Google sign-in.'); }
  if (!origin || url.origin !== origin || !origins.includes(origin) ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    fail(403, 'GOOGLE_ORIGIN_NOT_ALLOWED', 'This dashboard is not enabled for Google sign-in.');
  }
  return { clientId: clientId!, origin: origin!, domain: url.hostname };
}

export class GoogleTokenVerifier {
  private client = new OAuth2Client({ transporterOptions: { timeout: 10_000, retryConfig: { retry: 1 } } });
  async verify(credential: string, audience: string, nonce: string): Promise<TokenPayload> {
    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({ idToken: credential, audience });
      payload = ticket.getPayload();
    } catch (error: any) {
      if (error?.response?.status >= 500 || ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) {
        return fail(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google sign-in is temporarily unavailable. Please try again.');
      }
      return fail(401, 'GOOGLE_TOKEN_INVALID', 'Google sign-in could not be verified. Please try again.');
    }
    // The library verifies signature, issuer, audience and expiry. Bind the token to this flow as well.
    if (!payload || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 ||
      payload.email_verified !== true || typeof payload.email !== 'string' || payload.email.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || (payload as any).nonce !== nonce) {
      return fail(401, 'GOOGLE_TOKEN_INVALID', 'Google sign-in could not be verified. Please try again.');
    }
    return payload;
  }
}

export class GoogleAuthService {
  constructor(private database: Knex = db, private verifier = new GoogleTokenVerifier()) {}

  private async tenant(database: Knex, domain: string) {
    const domains = await database('company_domains').where({ domain_name: domain, status: 'active' }).limit(2);
    if (domains.length !== 1) return fail(403, 'GOOGLE_DOMAIN_UNAVAILABLE', 'This dashboard does not have an active company configured.');
    const company = await database('companies').where({ id: domains[0].company_id, status: 'active' }).whereNull('deleted_at').first('id');
    if (!company) return fail(403, 'GOOGLE_DOMAIN_UNAVAILABLE', 'This dashboard does not have an active company configured.');
    return company.id as string;
  }

  private async activeUser(database: Knex, id: string, companyId: string) {
    const user = await database('users').where({ id, company_id: companyId }).whereNull('deleted_at').first();
    if (!user || user.status !== 'active') return fail(403, 'GOOGLE_ACCOUNT_UNAVAILABLE', 'This account is not available on this dashboard.');
    return user;
  }

  async start(origin: string | undefined, ip: string, userId?: string) {
    const config = googleAuthConfig(origin);
    const token = random();
    const nonce = random();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.database.transaction(async trx => {
      const companyId = await this.tenant(trx, config.domain);
      if (userId) await this.activeUser(trx, userId, companyId);
      // Shared database throttling also works with multiple API replicas.
      const ipHash = hash(ip);
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`google-auth-ip:${ipHash}`]);
      const count = await trx('google_auth_sessions').where({ ip_hash: ipHash })
        .where('created_at', '>', new Date(Date.now() - 10 * 60_000)).count('* as count').first();
      if (Number(count?.count) >= 30) fail(429, 'GOOGLE_AUTH_RATE_LIMITED', 'Too many sign-in attempts. Please try again later.');
      await trx('google_auth_sessions').where('expires_at', '<', new Date(Date.now() - 86_400_000)).delete();
      await trx('google_auth_sessions').insert({
        token_hash: hash(token), nonce, origin: config.origin, company_id: companyId,
        user_id: userId || null, purpose: userId ? 'link' : 'login', ip_hash: ipHash,
        attempts: 0, created_at: new Date(), expires_at: expiresAt,
      });
    });
    return { client_id: config.clientId, flow_token: token, nonce, expires_at: expiresAt };
  }

  async complete(origin: string | undefined, body: any, userId?: string) {
    const config = googleAuthConfig(origin);
    if (!body || typeof body.credential !== 'string' || body.credential.length > 16_384 ||
      typeof body.flow_token !== 'string' || !/^[\w-]{43}$/.test(body.flow_token)) {
      return fail(400, 'GOOGLE_AUTH_BAD_REQUEST', 'Google credential and flow_token are required.');
    }
    const purpose = userId ? 'link' : 'login';
    const tokenHash = hash(body.flow_token);
    // Consume an attempt before external verification, even when verification or linking fails.
    const session = await this.database.transaction(async trx => {
      const row = await trx('google_auth_sessions').where({ token_hash: tokenHash, origin: config.origin, purpose })
        .whereNull('consumed_at').forUpdate().first();
      if (!row || row.user_id !== (userId || null) || new Date(row.expires_at).getTime() <= Date.now() || row.attempts >= 5) {
        return fail(401, 'GOOGLE_FLOW_EXPIRED', 'Please restart Google sign-in.');
      }
      await trx('google_auth_sessions').where({ token_hash: tokenHash }).update({ attempts: row.attempts + 1 });
      return row;
    });
    const identity = await this.verifier.verify(body.credential, config.clientId, session.nonce);
    const email = identity.email!.toLowerCase();
    try {
      return await this.database.transaction(async trx => {
        const current = await trx('google_auth_sessions').where({ token_hash: tokenHash }).forUpdate().first();
        if (!current || current.consumed_at || new Date(current.expires_at).getTime() <= Date.now()) {
          return fail(401, 'GOOGLE_FLOW_EXPIRED', 'Please restart Google sign-in.');
        }
        const companyId = await this.tenant(trx, config.domain);
        if (companyId !== session.company_id) return fail(403, 'GOOGLE_DOMAIN_UNAVAILABLE', 'Dashboard configuration changed. Please restart Google sign-in.');
        // Serialise competing first logins/link requests for the same Google identity/email.
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`google-sub:${identity.sub}`]);
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`google-email:${email}`]);
        const linked = await trx('google_auth_identities').where({ google_sub: identity.sub }).first();
        let user: any;
        let created = false;
        if (userId) {
          user = await this.activeUser(trx, userId, companyId);
          if (user.email?.toLowerCase() !== email) return fail(409, 'GOOGLE_EMAIL_MISMATCH', 'Choose the Google account matching your dashboard email.');
          if (typeof body.current_password !== 'string' || body.current_password.length > 72 || !user.password ||
            !await bcrypt.compare(body.current_password, user.password)) {
            return fail(401, 'GOOGLE_PASSWORD_REQUIRED', 'Enter your current dashboard password to connect Google.');
          }
          const previous = await trx('google_auth_identities').where({ user_id: userId }).first();
          if ((linked && linked.user_id !== userId) || (previous && previous.google_sub !== identity.sub)) {
            return fail(409, 'GOOGLE_ALREADY_LINKED', 'This Google account or dashboard account is already connected.');
          }
          if (!linked) await trx('google_auth_identities').insert({ google_sub: identity.sub, user_id: user.id });
        } else if (linked) {
          user = await this.activeUser(trx, linked.user_id, companyId);
        } else {
          // Include deleted rows: do not revive an account or bypass an existing identity.
          const matches = await trx('users').whereRaw('lower(email) = ?', [email]).limit(2).forUpdate();
          if (matches.length > 1) return fail(409, 'GOOGLE_ACCOUNT_CONFLICT', 'Multiple accounts match this email. Please contact your administrator.');
          if (matches.length === 1) {
            user = await this.activeUser(trx, matches[0].id, companyId);
            if (!authoritativeEmail(identity, email)) {
              return fail(409, 'GOOGLE_ACCOUNT_LINK_REQUIRED', 'Sign in with your existing method, then connect Google in account settings.');
            }
            const previous = await trx('google_auth_identities').where({ user_id: user.id }).first();
            if (previous) return fail(409, 'GOOGLE_ALREADY_LINKED', 'This dashboard account is already connected to another Google account.');
            // Preserve the existing password, role, plans, credits and account ID.
            await trx('google_auth_identities').insert({ google_sub: identity.sub, user_id: user.id });
          } else {
            // Google is not authoritative for arbitrary third-party email accounts.
            if (!authoritativeEmail(identity, email)) {
              return fail(403, 'GOOGLE_EMAIL_VERIFICATION_REQUIRED', 'Sign up with email first, then connect Google in account settings.');
            }
            [user] = await trx('users').insert({
              name: (identity.name || email.split('@')[0]).slice(0, 255), email,
              password: null, company_id: companyId, domain_name: config.domain,
              role: 'user', status: 'active',
            }).returning('*');
            await trx('google_auth_identities').insert({ google_sub: identity.sub, user_id: user.id });
            created = true;
          }
        }
        await trx('google_auth_sessions').where({ token_hash: tokenHash }).update({ consumed_at: new Date() });
        return { user, created, domain: config.domain };
      });
    } catch (error: any) {
      if (error?.code === '23505') return fail(409, 'GOOGLE_ACCOUNT_CONFLICT', 'Account setup changed. Please sign in again or connect Google from account settings.');
      throw error;
    }
  }
}

export default new GoogleAuthService();
