import { BaseModel } from '@surefy/models/base.model';
import { knex } from 'knex';
import type { FacebookFeature } from '../services/facebookOAuth.service';
import db from '@surefy/database';
import type { Knex } from 'knex';

class facebookPageModel extends BaseModel {
    constructor() {
        super('facebook_lead_pages')
    }

    async findAllByScope(feature: FacebookFeature, companyId: string, ownerId: string) {
        const table = feature === 'leads'
            ? 'facebook_lead_pages'
            : 'facebook_pages'

        return this.db(table)
            .where({
                companyId: companyId,
                ownerId: ownerId
            })
            .select(
                'id',
                'page_id',
                'name',
                'status',
                'connected_at',
                'updated_at'
            )
            .orderBy('updated_at', 'desc')
            .orderBy('id', 'desc');
    }

    findByScope(
        pageConnectionId: string,
        companyId: string,
        ownerId: string,
        trx?: Knex.Transaction,
    ) {
        return (trx ?? db)('facebook_lead_pages')
            .where({
                id: pageConnectionId,
                company_id: companyId,
                owner_id: ownerId,
            })
            .first();
    }

    findByFacebookId(pageId: string) {
  return db('facebook_lead_pages')
    .where({ page_id: pageId })
    .first();
}

}

export default new facebookPageModel();