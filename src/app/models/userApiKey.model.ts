import { BaseModel } from '@surefy/models/base.model';

class UserApiKeyModel extends BaseModel {
  constructor() {
    super('user_api_keys');
  }

  async findActiveUser(userId: string, companyId: string) {
    return this.db('users').where({ id: userId, company_id: companyId, status: 'active' })
      .whereNull('deleted_at').first();
  }

  async createKey(data: { user_id: string; company_id: string; key_hash: string; api_key_encrypted: string; key_prefix: string }) {
    return this.db.transaction(async trx => {
      // Serialize rotations for this user, including the first key creation.
      await trx('users').where({ id: data.user_id }).forUpdate().first();
      await trx('user_api_keys').where({ user_id: data.user_id })
        .whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
      const [record] = await trx('user_api_keys').insert(data)
        .returning(['id', 'company_id', 'key_prefix', 'created_at']);
      return record;
    });
  }

  async findByOwner(userId: string, companyId: string) {
    return this.query().where({ user_id: userId, company_id: companyId })
      .whereNull('revoked_at')
      .select('id', 'company_id', 'key_prefix', 'created_at', 'revoked_at', 'api_key_encrypted').orderBy('created_at', 'desc');
  }

  async revokeByOwner(id: string, userId: string, companyId: string) {
    return this.query().where({ id, user_id: userId, company_id: companyId })
      .update({ revoked_at: this.db.fn.now() });
  }

  async findActiveByHash(hash: string) {
    return this.db('user_api_keys as k')
      .join('users as u', 'u.id', 'k.user_id')
      .join('companies as c', 'c.id', 'k.company_id')
      .where('k.key_hash', hash)
      .whereRaw('u.company_id = k.company_id')
      .where({ 'u.status': 'active', 'c.status': 'active' })
      .whereNull('k.revoked_at').whereNull('u.deleted_at').whereNull('c.deleted_at')
      .select('u.id as userId', 'u.role as userRole', 'c.id as companyId').first();
  }
}

export default new UserApiKeyModel();
