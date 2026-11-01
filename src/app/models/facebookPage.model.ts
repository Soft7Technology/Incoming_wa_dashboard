import { BaseModel } from '@surefy/models/base.model';
import { knex } from 'knex';
import type { FacebookFeature } from '../services/facebookOAuth.service';
import type { Knex } from 'knex';
import { CustomError } from '@surefy/exceptions/CustomError';

type SelectedPage = {
    company_id: string;
    owner_id: string;
    page_id: string;
    name: string;
    facebook_user_id: string;
    token_ciphertext: string;
    data_access_expires_at?: Date | null;
}


class facebookPageModel extends BaseModel {
    constructor() {
        super('facebook_pages')
    }

    private pageTable(feature: FacebookFeature) {
        return feature === 'leads' ? 'facebook_lead_pages' : 'facebook_pages';
    }

    private sessionTable(feature: FacebookFeature) {
        return feature === 'leads'
            ? 'facebook_lead_oauth_sessions'
            : 'facebook_oauth_sessions';
    }


    async lockSession(
        trx: Knex.Transaction,
        feature: FacebookFeature,
        companyId: string,
        ownerId: string,
        browserHash: string,
    ) {
        return trx(this.sessionTable(feature))
            .where({
                company_id: companyId,
                owner_id: ownerId,
                browser_hash: browserHash,
            })
            .where('expires_at', '>', new Date())
            .forUpdate()
            .first();
    }

    async saveSelectedPage(
        trx: Knex.Transaction,
        feature: FacebookFeature,
        input: SelectedPage,
    ) {
        const table = this.pageTable(feature);

        const safeFields = [
            'id',
            'page_id',
            'name',
            'status',
            'connected_at',
            'updated_at',
        ];

        const values = {
            ...input,
            status: 'pending_subscription',
            error: null,
            connected_at: null,
            // Populate these from verified token metadata when available.
            token_expires_at: null,
            data_access_expires_at: input.data_access_expires_at ?? null,
            updated_at: new Date(),
        };

        // The unique page_id constraint also protects concurrent inserts.
        const [inserted] = await trx(table)
            .insert(values)
            .onConflict('page_id')
            .ignore()
            .returning(safeFields);

        if (inserted) {
            return { created: true, page: inserted };
        }

        const existing = await trx(table)
            .where({ page_id: input.page_id })
            .forUpdate()
            .first();

        if (
            !existing ||
            existing.company_id !== input.company_id ||
            existing.owner_id !== input.owner_id
        ) {
            throw new CustomError(
                'This Facebook Page cannot be connected to this account.',
                409,
                true,
            );
        }

        // Reconnect within the same account, preserving the connection UUID.
        const [updated] = await trx(table)
            .where({
                id: existing.id,
                company_id: input.company_id,
                owner_id: input.owner_id,
            })
            .update(values)
            .returning(safeFields);

        return { created: false, page: updated };
    }

    async markConnected(
        trx: Knex.Transaction,
        feature: FacebookFeature,
        id: string,
        companyId: string,
        ownerId: string,
        tokenCiphertext: string,
    ) {
        const now = new Date();
        const [page] = await trx(this.pageTable(feature))
            .where({
                id,
                company_id: companyId,
                owner_id: ownerId,
                token_ciphertext: tokenCiphertext,
                status: 'pending_subscription',
            })
            .update({ status: 'connected', connected_at: now, updated_at: now, error: null })
            .returning(['id', 'page_id', 'name', 'status', 'connected_at', 'updated_at']);
        return page;
    }

    async recordSubscriptionError(
        feature: FacebookFeature,
        id: string,
        companyId: string,
        ownerId: string,
        tokenCiphertext: string,
        message: string,
    ) {
        // A stale attempt must not modify a newer connection or a disconnect.
        return this.db(this.pageTable(feature))
            .where({
                id,
                company_id: companyId,
                owner_id: ownerId,
                token_ciphertext: tokenCiphertext,
                status: 'pending_subscription',
            })
            .update({ error: message, updated_at: new Date() });
    }

    async completeSession(
        trx: Knex.Transaction,
        feature: FacebookFeature,
        stateHash: string,
    ) {
        return trx(this.sessionTable(feature))
            .where({ state_hash: stateHash })
            .update({
                status: 'completed',
                candidates_ciphertext: null,
                error: null,
            });
    }
    async findAllByScope(feature: FacebookFeature, companyId: string, ownerId: string) {
        const table = feature === 'leads'
            ? 'facebook_lead_pages'
            : 'facebook_pages'

        return this.db(table)
            .where({
                company_id: companyId,
                owner_id: ownerId
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


    async cancelOAuthSessions(
        trx: Knex.Transaction,
        feature: FacebookFeature,
        companyId: string,
        ownerId: string,
    ) {
        return trx(this.sessionTable(feature))
            .where({
                company_id: companyId,
                owner_id: ownerId,
            })
            .delete();
    }

    async disconnectByScope(
        trx: Knex.Transaction,
        feature: FacebookFeature,
        pageConnectionId: string,
        companyId: string,
        ownerId: string,
    ) {
        const [page] = await trx(this.pageTable(feature))
            .where({
                id: pageConnectionId,
                company_id: companyId,
                owner_id: ownerId,
            })
            .update({
                status: 'disconnected',
                token_ciphertext: null,
                token_expires_at: null,
                data_access_expires_at: null,
                connected_at: null,
                error: null,
                updated_at: new Date(),
            })
            .returning(['id', 'status']);

        return page;
    }

    async disableLeadForms(
        trx: Knex.Transaction,
        pageConnectionId: string,
    ) {
        return trx('facebook_lead_forms')
            .where({
                page_connection_id: pageConnectionId,
            })
            .update({
                enabled: false,
            });
    }

}

export default new facebookPageModel();
