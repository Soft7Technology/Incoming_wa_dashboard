import { Knex } from 'knex';
import db from '@surefy/database';
import { FacebookError } from '../utils/facebook';

export interface SocialScope {
  companyId: string;
  ownerId: string;
  userId: string;
  reviewPageId?: string;
}

/** Shared owner check for social integrations that write customer data. */
export async function requireSocialOwner(scope: SocialScope, database: Knex = db) {
  if (!scope.companyId || !scope.ownerId || !scope.userId)
    throw new FacebookError(403, 'A company account is required.');
  const company = await database('companies')
    .where({ id: scope.companyId, status: 'active' })
    .whereNull('deleted_at')
    .first('id');
  if (!company) throw new FacebookError(403, 'Company account is unavailable.');
  const owner = await database('users')
    .where({ id: scope.ownerId, company_id: scope.companyId, status: 'active' })
    .whereNull('deleted_at')
    .first('id');
  if (!owner) throw new FacebookError(403, 'Account owner is unavailable.');
  if (scope.userId !== scope.ownerId)
    throw new FacebookError(403, 'Only the account owner can manage this integration.');
}
