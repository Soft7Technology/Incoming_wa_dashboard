import type { Knex } from 'knex';
import db from '@surefy/database';

export type FacebookFormInput = {
    id: string;
    name: string;
    status: string;
    questions: unknown[];
};

class FacebookLeadFormModel {
    async upsertMany(
        trx: Knex.Transaction,
        pageConnectionId: string,
        forms: FacebookFormInput[],
    ) {
        if (forms.length === 0) return [];

        // Deduplicate in case a form appears on multiple API pages.
        const uniqueForms = [...new Map(
            forms.map((form) => [form.id, form]),
        ).values()];

        const rows = uniqueForms.map((form) => ({
            page_connection_id: pageConnectionId,
            form_id: form.id,
            name: form.name,
            status: form.status,
            questions: JSON.stringify(form.questions),
            enabled: false,
        }));

        return trx('facebook_lead_forms')
            .insert(rows)
            .onConflict(['page_connection_id', 'form_id'])
            .merge(['name', 'status', 'questions'])
            .returning([
                'id',
                'page_connection_id',
                'form_id',
                'name',
                'status',
                'questions',
                'enabled',
                'last_synced_at',
                'sync_error',
            ]);
    }

    async findAllByPage(
        pageConnectionId: string,
        companyId: string,
        ownerId: string,
    ) {
        return db('facebook_lead_forms as form')
            .join(
                'facebook_lead_pages as page',
                'page.id',
                'form.page_connection_id',
            )
            .where({
                'form.page_connection_id': pageConnectionId,
                'page.company_id': companyId,
                'page.owner_id': ownerId,
            })
            .select(
                'form.id',
                'form.page_connection_id',
                'form.form_id',
                'form.name',
                'form.status',
                'form.questions',
                'form.enabled',
                'form.last_synced_at',
                'form.sync_error',
            )
            .orderBy('form.name', 'asc')
            .orderBy('form.id', 'asc');
    }

    async updateEnabledByScope(
        formConnectionId: string,
        enabled: boolean,
        companyId: string,
        ownerId: string,
    ) {
        const ownedPages = db('facebook_lead_pages')
            .select('id')
            .where({
                company_id: companyId,
                owner_id: ownerId,
            });

        const [form] = await db('facebook_lead_forms')
            .where({ id: formConnectionId })
            .whereIn('page_connection_id', ownedPages)
            .update({ enabled })
            .returning([
                'id',
                'page_connection_id',
                'form_id',
                'name',
                'status',
                'questions',
                'enabled',
                'last_synced_at',
                'sync_error',
            ]);

        return form;
    }


    findSyncContext(
        formConnectionId: string,
        companyId: string,
        ownerId: string,
        trx?: Knex.Transaction,
    ) {
        return (trx ?? db)('facebook_lead_forms as form')
            .join(
                'facebook_lead_pages as page',
                'page.id',
                'form.page_connection_id',
            )
            .where({
                'form.id': formConnectionId,
                'page.company_id': companyId,
                'page.owner_id': ownerId,
            })
            .select(
                'form.id',
                'form.form_id',
                'form.page_connection_id',
                'form.enabled',
                'form.last_synced_at',
                'page.status as page_status',
                'page.updated_at as page_updated_at',
                'page.token_ciphertext',
                'page.token_expires_at',
                'page.data_access_expires_at',
            )
            .first();
    }

    async markSynced(
        trx: Knex.Transaction,
        formConnectionId: string,
        syncedAt: Date,
    ) {
        return trx('facebook_lead_forms')
            .where({ id: formConnectionId })
            .update({
                last_synced_at: syncedAt,
                sync_error: null,
            });
    }


    async findByScope(
        formConnectionId: string,
        companyId: string,
        ownerId: string,
    ) {
        return db('facebook_lead_forms as form')
            .join(
                'facebook_lead_pages as page',
                'page.id',
                'form.page_connection_id',
            )
            .where({
                'form.id': formConnectionId,
                'page.company_id': companyId,
                'page.owner_id': ownerId,
            })
            .select('form.id')
            .first();
    }

    findForWebhook(
  pageConnectionId: string,
  formId: string,
  trx?: Knex.Transaction,
) {
  return (trx ?? db)('facebook_lead_forms')
    .where({
      page_connection_id: pageConnectionId,
      form_id: formId,
    })
    .select('id', 'enabled')
    .first();
}
}

export default new FacebookLeadFormModel();