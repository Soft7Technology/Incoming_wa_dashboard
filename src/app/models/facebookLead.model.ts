import type { Knex } from 'knex';
import db from '@surefy/database';

export type FacebookLeadInput = {
    id: string;
    created_time: string;
    field_data: Array<{
        name: string;
        values: string[];
    }>;
};

class FacebookLeadModel {
    async upsertMany(
        trx: Knex.Transaction,
        formConnectionId: string,
        leads: FacebookLeadInput[],
        syncedAt: Date,
    ): Promise<number> {
        const uniqueLeads = [...new Map(
            leads.map((lead) => [lead.id, lead]),
        ).values()].sort((a, b) => a.id.localeCompare(b.id));

        // Keep each SQL statement reasonably sized.
        for (let offset = 0; offset < uniqueLeads.length; offset += 500) {
            const rows = uniqueLeads.slice(offset, offset + 500).map((lead) => ({
                form_connection_id: formConnectionId,
                lead_id: lead.id,
                field_data: JSON.stringify(lead.field_data),
                submitted_at: new Date(lead.created_time),
                synced_at: syncedAt,
            }));

            await trx('facebook_leads')
                .insert(rows)
                .onConflict(['form_connection_id', 'lead_id'])
                .merge(['field_data', 'submitted_at', 'synced_at']);
        }

        return uniqueLeads.length;
    }

    async findPageByScope(
        formConnectionId: string,
        companyId: string,
        ownerId: string,
        limit: number,
        offset: number,
    ) {
        return db('facebook_leads as lead')
            .join(
                'facebook_lead_forms as form',
                'form.id',
                'lead.form_connection_id',
            )
            .join(
                'facebook_lead_pages as page',
                'page.id',
                'form.page_connection_id',
            )
            .where({
                'lead.form_connection_id': formConnectionId,
                'page.company_id': companyId,
                'page.owner_id': ownerId,
            })
            .select(
                'lead.id',
                'lead.form_connection_id',
                'lead.lead_id',
                'lead.field_data',
                'lead.submitted_at',
                'lead.synced_at',
            )
            .orderBy('lead.submitted_at', 'desc')
            .orderBy('lead.id', 'desc')
            .limit(limit + 1)
            .offset(offset);
    }

    async exists(formConnectionId: string, leadId: string): Promise<boolean> {
        const lead = await db('facebook_leads')
            .where({
                form_connection_id: formConnectionId,
                lead_id: leadId,
            })
            .select('id')
            .first();

        return Boolean(lead);
    }

    async insertIfMissing(
        trx: Knex.Transaction,
        formConnectionId: string,
        lead: FacebookLeadInput,
    ) {
        return trx('facebook_leads')
            .insert({
                form_connection_id: formConnectionId,
                lead_id: lead.id,
                field_data: JSON.stringify(lead.field_data),
                submitted_at: new Date(lead.created_time),
                synced_at: new Date(),
            })
            .onConflict(['form_connection_id', 'lead_id'])
            .ignore();
    }
}

export default new FacebookLeadModel();