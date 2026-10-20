import db from '@surefy/database';
import { openToken, WabaOnboardingError } from '../utils/wabaOnboarding';

class WabaCredentials {
  async forAccount(userId: string, companyId: string, wabaRecordId: string) {
    const row = await db('waba_credentials').where({ user_id: userId, company_id: companyId, waba_record_id: wabaRecordId }).first();
    return row ? this.read(row) : null;
  }
  private read(row: any) {
    if (row.expires_at && new Date(row.expires_at) <= new Date()) throw new WabaOnboardingError('SIGNUP_TOKEN_INVALID', 'The connected WhatsApp authorization expired. Reconnect through Embedded Signup.', false, 403);
    return openToken(row.token_encrypted, { userId: row.user_id, companyId: row.company_id }, row.onboarding_id);
  }
  async forResource(metaId: string) {
    // Each Meta asset is globally unique. Join ownership on every edge before decrypting.
    const row = await db('waba_accounts as w').leftJoin('waba_credentials as c', function () {
      this.on('w.id', 'c.waba_record_id').andOn('w.user_id', 'c.user_id').andOn('w.company_id', 'c.company_id');
    }).whereNull('w.deleted_at').andWhere(query => query
      .where('w.waba_id', metaId).orWhereExists(db('phone_numbers as p').select(db.raw('1')).whereRaw('p.waba_id = w.id AND p.user_id = w.user_id AND p.company_id = w.company_id')
        .whereNull('p.deleted_at').where('p.phone_number_id', metaId))
      .orWhereExists(db('templates as t').select(db.raw('1')).whereRaw('t.waba_id = w.id AND t.company_id = w.company_id')
        .whereNull('t.deleted_at').where('t.template_id', metaId)))
      .select('c.*', 'w.connection_status').first();
    if (!row) return null;
    if (!['legacy', 'connected'].includes(row.connection_status)) throw new WabaOnboardingError('WABA_SETUP_REQUIRED',
      'This WhatsApp account has not finished connecting. Complete its onboarding before using Meta operations.', false, 403);
    if (!row.token_encrypted) {
      if (row.connection_status === 'connected') throw new WabaOnboardingError('WABA_CREDENTIAL_UNAVAILABLE', 'Reconnect this WhatsApp account to restore its authorization.', false, 403);
      return null;
    }
    return this.read(row);
  }
}
export default new WabaCredentials();
