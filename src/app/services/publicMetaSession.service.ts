import { createHash, randomBytes, randomUUID } from 'crypto';
import { Knex } from 'knex';
import db from '@surefy/database';

export const publicMetaSessionLifetime = 30 * 24 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Browser workspaces have no application login credentials or dashboard JWT. */
export class PublicMetaSessionService {
  constructor(private database: Knex = db) {}

  async find(token: unknown) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = await this.database('public_meta_sessions as s')
      .join('companies as c', 'c.id', 's.company_id')
      .join('users as u', 'u.id', 's.owner_id')
      .where({ 's.token_hash': hash(token), 'c.status': 'active', 'u.status': 'active' })
      .whereRaw('u.company_id = s.company_id')
      .whereNull('c.deleted_at').whereNull('u.deleted_at')
      .where('s.expires_at', '>', new Date())
      .first('s.company_id', 's.owner_id');
    return row ? { companyId: row.company_id as string, ownerId: row.owner_id as string,
      userId: row.owner_id as string } : null;
  }

  async start(existingToken: unknown) {
    const existing = await this.find(existingToken);
    const expires = new Date(Date.now() + publicMetaSessionLifetime);
    if (existing) {
      await this.database('public_meta_sessions').where({ token_hash: hash(existingToken as string) })
        .update({ expires_at: expires });
      return { token: existingToken as string };
    }
    const token = randomBytes(32).toString('base64url');
    await this.database.transaction(async trx => {
      const companyId = randomUUID(), ownerId = randomUUID();
      // Separate ownership records allow the existing Meta services to retain all
      // their tenant checks and foreign keys. No shared customer account is used.
      await trx('companies').insert({ id: companyId, name: 'Public Meta workspace',
        email: `${companyId}@meta-workspace.invalid`, status: 'active',
        settings: { public_meta_workspace: true } });
      await trx('users').insert({ id: ownerId, company_id: companyId, name: 'Meta workspace visitor',
        email: null, password: '!public-meta-workspace', role: 'company', status: 'active',
        settings: { public_meta_workspace: true } });
      await trx('public_meta_sessions').insert({ token_hash: hash(token), company_id: companyId,
        owner_id: ownerId, expires_at: expires });
    });
    return { token };
  }
}

export default new PublicMetaSessionService();
