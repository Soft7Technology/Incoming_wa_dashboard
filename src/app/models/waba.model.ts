import { BaseModel } from '@surefy/models/base.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import planUsage from '../services/planUsage.service';

class WabaModel extends BaseModel {
  constructor() {
    super('waba_accounts');
  }

  async findByCompanyId(companyId: string) {
    return this.query().where({ company_id: companyId, deleted_at: null });
  }


  async findByUserId(userId?: string, companyId?: string) {
    if (!userId || !companyId) throw new Error('User and company context are required');
    return this.query()
      .where({ 'waba_accounts.user_id': userId, 'waba_accounts.company_id': companyId })
      .whereNull('waba_accounts.deleted_at')
      .select('*');
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId }).first();
  }

  async upsertOwnedAccount(data: any) {
    const [account] = await this.query().insert({ ...data, meta_data: JSON.stringify(data.meta_data) })
      .onConflict('waba_id').merge(['name', 'currency', 'timezone', 'message_template_namespace', 'meta_data', 'deleted_at', 'updated_at'])
      .where({ 'waba_accounts.user_id': data.user_id, 'waba_accounts.company_id': data.company_id }).returning('*');
    if (!account) throw new HTTP400Error({ message: 'WABA is already connected to another account' });
    return account;
  }

  async findOwnedForSync(wabaId: string, userId: string, companyId: string) {
    const column = /^\d+$/.test(wabaId) ? 'waba_id' : 'id';
    return this.query().where({ [column]: wabaId, user_id: userId, company_id: companyId })
      .whereNull('deleted_at').first();
  }

  /** Save one complete Meta snapshot; preserve local phone UUIDs and their relations. */
  async syncAccountAndPhones(waba: any, details: any, phones: any[]) {
    return planUsage.syncWabaNumbers(waba.user_id, async (trx, capacity) => {
      const scope = { id: waba.id, user_id: waba.user_id, company_id: waba.company_id };
      const current = await trx('waba_accounts').where(scope).whereNull('deleted_at').forUpdate().first();
      if (!current || current.waba_id !== waba.waba_id) {
        throw new HTTP404Error({ message: 'WABA not found in your account' });
      }

      // Include soft-deleted numbers so their unique Meta IDs can be reused safely.
      const existing = phones.length ? await trx('phone_numbers')
        .whereIn('phone_number_id', phones.map(phone => phone.id)).forUpdate() : [];
      if (existing.some(phone => phone.user_id !== current.user_id ||
          phone.company_id !== current.company_id || phone.waba_id !== current.id)) {
        throw new HTTP400Error({ message: 'A phone number is already connected to another account or WABA' });
      }
      const byMetaId = new Map(existing.map(phone => [phone.phone_number_id, phone]));
      const now = new Date();
      const [account] = await trx('waba_accounts').where(scope).update({
        name: details.name ?? current.name,
        currency: details.currency ?? current.currency,
        timezone: details.timezone ?? current.timezone,
        message_template_namespace: details.message_template_namespace ?? current.message_template_namespace,
        meta_data: JSON.stringify({ ...current.meta_data, ...details }),
        updated_at: now,
        last_synced_at: now,
      }).returning('*');

      const phoneNumbers: any[] = [];
      const skipped: Array<{ phone_number_id: string; reason: string }> = [];
      for (let offset = 0; offset < phones.length; offset += 200) {
        const rows = phones.slice(offset, offset + 200).flatMap(phone => {
          const saved = byMetaId.get(phone.id);
          const retained = saved && !saved.deleted_at;
          if (!retained && capacity.remaining <= 0) {
            skipped.push({ phone_number_id: phone.id, reason: capacity.inactiveReason });
            return [];
          }
          const active = retained ? saved.active !== false : capacity.remaining > 0;
          if (!retained && active) capacity.remaining--;
          return [{
            user_id: current.user_id, company_id: current.company_id, waba_id: current.id,
            phone_number_id: phone.id, display_phone_number: phone.display_phone_number,
            verified_name: phone.verified_name ?? saved?.verified_name ?? null,
            quality_rating: phone.quality_rating ?? saved?.quality_rating ?? null,
            code_verification_status: phone.code_verification_status ?? saved?.code_verification_status ?? null,
            active, inactive_reason: active ? null : (retained && saved.inactive_reason) || capacity.inactiveReason,
            connection_status: current.connection_status === 'pending' ? 'pending' : phone.status
              ? phone.status === 'CONNECTED' && phone.platform_type !== 'ON_PREMISE' ? 'connected' : 'pending'
              : saved?.connection_status ?? 'legacy',
            meta_data: JSON.stringify(phone), updated_at: now, deleted_at: null,
          }];
        });
        if (!rows.length) continue;
        const saved = await trx('phone_numbers').insert(rows).onConflict('phone_number_id').merge([
          'display_phone_number', 'verified_name', 'quality_rating', 'code_verification_status',
          'meta_data', 'updated_at', 'deleted_at',
          'active', 'inactive_reason',
          'connection_status',
        ]).where({
          'phone_numbers.user_id': current.user_id,
          'phone_numbers.company_id': current.company_id,
          'phone_numbers.waba_id': current.id,
        }).returning('*');
        // A concurrent connection must never transfer a number from another tenant.
        if (saved.length !== rows.length) {
          throw new HTTP400Error({ message: 'A phone number is already connected to another account or WABA' });
        }
        phoneNumbers.push(...saved);
      }
      const updated = phoneNumbers.filter(phone => byMetaId.has(phone.phone_number_id)).length;
      return { waba: account, phone_numbers: phoneNumbers, total_phone_numbers: phones.length,
        created: phoneNumbers.length - updated, updated,
        skipped_count: skipped.length, skipped_phone_numbers: skipped,
        remaining_slots: Number.isFinite(capacity.remaining) ? capacity.remaining : null,
        active_count: phoneNumbers.filter(phone => phone.active).length,
        inactive_count: phoneNumbers.filter(phone => !phone.active).length };
    });
  }

  async findByIdInternal(id: string) {
    return this.findById(id);
  }

  async findWABA(id:string){
    console.log("Id",id)
    return this.query().where({id}).first()
  }
}

export default new WabaModel();
