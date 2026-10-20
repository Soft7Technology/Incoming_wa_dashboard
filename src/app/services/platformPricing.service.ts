import db from '@surefy/database';
import { Knex } from 'knex';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { CatalogActor, platformAdmin } from './planCatalog.service';

export function feeAmount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100000000) {
    throw new HTTP400Error({ message: `${field} must be an integer from 0 to 100000000 paise` });
  }
  return value;
}

// Legacy pending checkouts were quoted before platform fees became configurable.
export function quotedPlatformFee(plan: any): number {
  if (!['Monthly', 'Yearly'].includes(plan.billing_cycle))
    throw new HTTP400Error({ message: 'Unsupported paid subscription billing cycle' });
  return feeAmount(plan.platform_fee_paise ?? (plan.billing_cycle === 'Monthly' ? 10000 : 100000), 'platform_fee_paise');
}

class PlatformPricingService {
  async get(connection: Knex | Knex.Transaction = db) {
    const row = await connection('platform_fee_settings').where({ id: 'default' }).first();
    if (!row) throw new HTTP400Error({ message: 'Platform pricing is not configured; apply the platform pricing migration' });
    return { ...row, free_fee_paise: 0 };
  }

  async feeFor(billingCycle: string, connection: Knex | Knex.Transaction = db): Promise<number> {
    if (billingCycle === 'Free') return 0;
    if (!['Monthly', 'Yearly'].includes(billingCycle))
      throw new HTTP400Error({ message: 'Unsupported paid subscription billing cycle' });
    const policy = await this.get(connection);
    const key = billingCycle === 'Monthly' ? 'monthly_fee_paise' : 'yearly_fee_paise';
    return feeAmount(policy[key], key);
  }

  async update(actor: CatalogActor, body: any) {
    platformAdmin(actor);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['monthly_fee_paise', 'yearly_fee_paise'].includes(key))) {
      throw new HTTP400Error({ message: 'Only monthly_fee_paise and yearly_fee_paise are accepted' });
    }
    const values = { monthly_fee_paise: feeAmount(body.monthly_fee_paise, 'monthly_fee_paise'),
      yearly_fee_paise: feeAmount(body.yearly_fee_paise, 'yearly_fee_paise') };
    return db.transaction(async trx => {
      const previous = await trx('platform_fee_settings').where({ id: 'default' }).forUpdate().first();
      if (!previous) throw new HTTP400Error({ message: 'Platform pricing is not configured' });
      const [row] = await trx('platform_fee_settings').where({ id: 'default' })
        .update({ ...values, updated_by: actor.userId, updated_at: new Date() }).returning('*');
      await trx('platform_pricing_changes').insert({ actor_id: actor.userId, resource_type: 'platform_fee',
        resource_id: 'default', previous_values: JSON.stringify({ monthly_fee_paise: previous.monthly_fee_paise,
          yearly_fee_paise: previous.yearly_fee_paise }), new_values: JSON.stringify(values) });
      return row;
    });
  }
}

export default new PlatformPricingService();
