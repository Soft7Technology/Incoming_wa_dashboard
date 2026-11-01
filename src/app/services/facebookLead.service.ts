import axios from 'axios';
import { createHmac } from 'crypto';
import db from '@surefy/database';
import { CustomError } from '@surefy/exceptions/CustomError';
import facebookLeadPageModel from '../models/facebookLeadPage.model';
import facebookLeadFormModel, {
    FacebookFormInput,
} from '../models/facebookLeadForm.model';
import facebookLeadModel, {
    FacebookLeadInput,
} from '../models/facebookLead.model';
import { decrypt, graphFailure } from '../utils/facebook';

type PageScope = {
    companyId: string;
    ownerId: string;
    userId: string;
};

type LeadsResponse = {
    data?: FacebookLeadInput[];
    error?: { code?: number };
    paging?: {
        next?: string;
        cursors?: { after?: string };
    };
};

type FormsResponse = {
    data?: FacebookFormInput[];
    error?: { code?: number };
    paging?: {
        next?: string;
        cursors?: { after?: string };
    };
};

class FacebookLeadService {
    async refreshForms(pageConnectionId: string, scope: PageScope) {
        if (scope.userId !== scope.ownerId) {
            throw new CustomError(
                'Only the account owner can refresh Facebook forms.',
                403,
            );
        }

        const page = await facebookLeadPageModel.findByScope(
            pageConnectionId,
            scope.companyId,
            scope.ownerId,
        );

        if (!page) {
            throw new CustomError('Facebook Page connection not found.', 404);
        }

        // Reading form metadata can also be allowed before webhook setup.
        const allowedStatuses = ['connected', 'pending_subscription'];

        if (
            !allowedStatuses.includes(page.status) ||
            !page.token_ciphertext
        ) {
            throw new CustomError(
                'This Page has no usable authorization. Reconnect it.',
                409,
            );
        }

        const expired = [
            page.token_expires_at,
            page.data_access_expires_at,
        ].some(
            (value) => value && new Date(value).getTime() <= Date.now(),
        );

        if (expired) {
            throw new CustomError(
                'Facebook authorization has expired. Reconnect this Page.',
                409,
            );
        }

        let token: string;

        try {
            token = decrypt(page.token_ciphertext);
        } catch {
            throw new CustomError(
                'Unable to read the stored Facebook credentials.',
                503,
            );
        }

        // Fetch every API page before writing anything to the database.
        const forms = await this.fetchForms(page.page_id, token);

        return db.transaction(async (trx) => {
            const current = await facebookLeadPageModel
                .findByScope(
                    pageConnectionId,
                    scope.companyId,
                    scope.ownerId,
                    trx,
                )
                .forUpdate();

            // A disconnect or reconnect may have happened during the API call.
            if (
                !current ||
                current.page_id !== page.page_id ||
                current.token_ciphertext !== page.token_ciphertext ||
                current.status !== page.status ||
                new Date(current.updated_at).getTime() !==
                new Date(page.updated_at).getTime()
            ) {
                throw new CustomError(
                    'The Page connection changed. Refresh again.',
                    409,
                );
            }

            const saved = await facebookLeadFormModel.upsertMany(
                trx,
                pageConnectionId,
                forms,
            );

            return {
                page_connection_id: pageConnectionId,
                refreshed_count: saved.length,
                forms: saved,
            };
        });
    }

    private async fetchForms(
        pageId: string,
        token: string,
    ): Promise<FacebookFormInput[]> {
        const version = process.env.FACEBOOK_GRAPH_VERSION;
        const secret =
            process.env.FACEBOOK_LEADS_APP_SECRET ||
            process.env.FACEBOOK_APP_SECRET;

        if (!version || !/^v\d+\.\d+$/.test(version) || !secret) {
            throw new CustomError(
                'Facebook Leads API configuration is incomplete.',
                503,
            );
        }

        if (!/^\d{1,80}$/.test(pageId)) {
            throw new CustomError('The stored Facebook Page ID is invalid.', 409);
        }

        const appsecretProof = createHmac('sha256', secret)
            .update(token)
            .digest('hex');

        const forms: FacebookFormInput[] = [];
        const seenCursors = new Set<string>();
        let after: string | undefined;

        do {
            let payload: FormsResponse;

            try {
                const response = await axios.get<FormsResponse>(
                    `https://graph.facebook.com/${version}/${pageId}/leadgen_forms`,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                        },
                        params: {
                            fields: 'id,name,status,questions',
                            limit: 100,
                            appsecret_proof: appsecretProof,
                            ...(after ? { after } : {}),
                        },
                        timeout: 15000,
                        maxRedirects: 0,
                        maxContentLength: 5 * 1024 * 1024,
                    },
                );

                payload = response.data;
            } catch (error: unknown) {
                // Never propagate Axios errors containing request credentials.
                const code = axios.isAxiosError(error)
                    ? error.response?.data?.error?.code
                    : undefined;

                if (code !== undefined) {
                    const safe = graphFailure(Number(code));
                    throw new CustomError(safe.message, safe.status);
                }

                throw new CustomError(
                    'Unable to fetch Facebook forms. Please try again.',
                    502,
                );
            }

            if (payload?.error) {
                const safe = graphFailure(Number(payload.error.code));
                throw new CustomError(safe.message, safe.status);
            }

            if (!Array.isArray(payload?.data)) {
                throw new CustomError('Facebook returned invalid form data.', 502);
            }

            for (const form of payload.data) {
                if (
                    !form ||
                    typeof form.id !== 'string' ||
                    !/^\d{1,80}$/.test(form.id) ||
                    typeof form.name !== 'string' ||
                    typeof form.status !== 'string' ||
                    !Array.isArray(form.questions)
                ) {
                    throw new CustomError(
                        'Facebook returned incomplete form metadata.',
                        502,
                    );
                }

                forms.push(form);
            }

            if (!payload.paging?.next) break;

            const nextCursor = payload.paging.cursors?.after;

            if (!nextCursor || seenCursors.has(nextCursor)) {
                throw new CustomError(
                    'Facebook returned invalid pagination. Please retry.',
                    502,
                );
            }

            seenCursors.add(nextCursor);
            after = nextCursor;
        } while (after);

        return forms;
    }

    private async fetchLeads(
        formId: string,
        token: string,
    ): Promise<FacebookLeadInput[]> {
        const version = process.env.FACEBOOK_GRAPH_VERSION;
        const secret =
            process.env.FACEBOOK_LEADS_APP_SECRET ||
            process.env.FACEBOOK_APP_SECRET;

        if (!version || !/^v\d+\.\d+$/.test(version) || !secret) {
            throw new CustomError(
                'Facebook Leads API configuration is incomplete.',
                503,
            );
        }

        if (!/^\d{1,80}$/.test(formId)) {
            throw new CustomError('The stored Facebook form ID is invalid.', 409);
        }

        const proof = createHmac('sha256', secret)
            .update(token)
            .digest('hex');

        const leads: FacebookLeadInput[] = [];
        const seenCursors = new Set<string>();
        let after: string | undefined;

        do {
            let payload: LeadsResponse;

            try {
                const response = await axios.get<LeadsResponse>(
                    `https://graph.facebook.com/${version}/${formId}/leads`,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                        },
                        params: {
                            fields: 'id,created_time,field_data',
                            limit: 100,
                            appsecret_proof: proof,
                            ...(after ? { after } : {}),
                        },
                        timeout: 15000,
                        maxRedirects: 0,
                        maxContentLength: 5 * 1024 * 1024,
                    },
                );

                payload = response.data;
            } catch (error: unknown) {
                const code = axios.isAxiosError(error)
                    ? error.response?.data?.error?.code
                    : undefined;

                if (code !== undefined) {
                    const safe = graphFailure(Number(code));
                    throw new CustomError(safe.message, safe.status);
                }

                throw new CustomError(
                    'Unable to fetch Facebook leads. Please try again.',
                    502,
                );
            }

            if (payload?.error) {
                const safe = graphFailure(Number(payload.error.code));
                throw new CustomError(safe.message, safe.status);
            }

            if (!Array.isArray(payload?.data)) {
                throw new CustomError('Facebook returned invalid lead data.', 502);
            }

            for (const lead of payload.data) {
                if (
                    !lead ||
                    typeof lead.id !== 'string' ||
                    !/^\d{1,80}$/.test(lead.id) ||
                    typeof lead.created_time !== 'string' ||
                    !Number.isFinite(Date.parse(lead.created_time)) ||
                    !Array.isArray(lead.field_data) ||
                    !lead.field_data.every(
                        (field) =>
                            field &&
                            typeof field.name === 'string' &&
                            Array.isArray(field.values) &&
                            field.values.every((value) => typeof value === 'string'),
                    )
                ) {
                    throw new CustomError(
                        'Facebook returned incomplete lead data.',
                        502,
                    );
                }

                leads.push(lead);
            }

            if (!payload.paging?.next) break;

            const nextCursor = payload.paging.cursors?.after;

            if (!nextCursor || seenCursors.has(nextCursor)) {
                throw new CustomError(
                    'Facebook returned invalid pagination. Please retry.',
                    502,
                );
            }

            seenCursors.add(nextCursor);
            after = nextCursor;
        } while (after);

        return leads;
    }

    async listForms(pageConnectionId: string, scope: PageScope) {
        if (scope.userId !== scope.ownerId) {
            throw new CustomError(
                'Only the account owner can view Facebook forms.',
                403,
            );
        }

        const page = await facebookLeadPageModel.findByScope(
            pageConnectionId,
            scope.companyId,
            scope.ownerId,
        );

        if (!page) {
            throw new CustomError(
                'Facebook Page connection not found.',
                404,
            );
        }

        const forms = await facebookLeadFormModel.findAllByPage(
            pageConnectionId,
            scope.companyId,
            scope.ownerId,
        );

        return {
            page_connection_id: pageConnectionId,
            forms,
        };
    }

    async updateForm(
        formConnectionId: string,
        enabled: boolean,
        scope: PageScope,
    ) {
        if (scope.userId !== scope.ownerId) {
            throw new CustomError(
                'Only the account owner can update Facebook forms.',
                403,
            );
        }

        const form = await facebookLeadFormModel.updateEnabledByScope(
            formConnectionId,
            enabled,
            scope.companyId,
            scope.ownerId,
        );

        if (!form) {
            throw new CustomError(
                'Facebook form connection not found.',
                404,
            );
        }

        return form;
    }


    async syncForm(formConnectionId: string, scope: PageScope) {
        if (scope.userId !== scope.ownerId) {
            throw new CustomError(
                'Only the account owner can sync Facebook leads.',
                403,
            );
        }

        const context = await facebookLeadFormModel.findSyncContext(
            formConnectionId,
            scope.companyId,
            scope.ownerId,
        );

        if (!context) {
            throw new CustomError('Facebook form connection not found.', 404);
        }

        if (!context.enabled) {
            throw new CustomError('Enable this form before syncing leads.', 409);
        }

        // Manual retrieval can work before webhook subscription is complete.
        if (
            !['connected', 'pending_subscription'].includes(context.page_status) ||
            !context.token_ciphertext
        ) {
            throw new CustomError('Reconnect the Facebook Page before syncing.', 409);
        }

        const expired = [
            context.token_expires_at,
            context.data_access_expires_at,
        ].some((value) => value && new Date(value).getTime() <= Date.now());

        if (expired) {
            throw new CustomError(
                'Facebook authorization has expired. Reconnect the Page.',
                409,
            );
        }

        let token: string;

        try {
            token = decrypt(context.token_ciphertext);
        } catch {
            throw new CustomError(
                'Unable to read the stored Facebook credentials.',
                503,
            );
        }

        // No database locks are held while fetching from Facebook.
        const leads = await this.fetchLeads(context.form_id, token);

        return db.transaction(async (trx) => {
            // Lock the Page before the form, matching the refresh workflow.
            const page = await facebookLeadPageModel
                .findByScope(
                    context.page_connection_id,
                    scope.companyId,
                    scope.ownerId,
                    trx,
                )
                .forUpdate();

            if (
                !page ||
                page.token_ciphertext !== context.token_ciphertext ||
                page.status !== context.page_status ||
                String(page.updated_at) !== String(context.page_updated_at)
            ) {
                throw new CustomError(
                    'The Page connection changed. Please sync again.',
                    409,
                );
            }

            const current = await facebookLeadFormModel
                .findSyncContext(
                    formConnectionId,
                    scope.companyId,
                    scope.ownerId,
                    trx,
                )
                .forUpdate('form');

            if (
                !current ||
                !current.enabled ||
                current.form_id !== context.form_id ||
                current.page_connection_id !== context.page_connection_id ||
                String(current.last_synced_at) !== String(context.last_synced_at)
            ) {
                throw new CustomError(
                    'The form changed or another sync completed. Please retry.',
                    409,
                );
            }

            const syncedAt = new Date();

            const processedCount = await facebookLeadModel.upsertMany(
                trx,
                formConnectionId,
                leads,
                syncedAt,
            );

            await facebookLeadFormModel.markSynced(
                trx,
                formConnectionId,
                syncedAt,
            );

            return {
                form_connection_id: formConnectionId,
                processed_count: processedCount,
                last_synced_at: syncedAt.toISOString(),
            };
        });
    }


    async listLeads(
        formConnectionId: string,
        scope: PageScope,
        pagination: { page: number; limit: number },
    ) {
        if (scope.userId !== scope.ownerId) {
            throw new CustomError(
                'Only the account owner can view Facebook leads.',
                403,
            );
        }

        const form = await facebookLeadFormModel.findByScope(
            formConnectionId,
            scope.companyId,
            scope.ownerId,
        );

        if (!form) {
            throw new CustomError(
                'Facebook form connection not found.',
                404,
            );
        }

        const { page, limit } = pagination;

        const rows = await facebookLeadModel.findPageByScope(
            formConnectionId,
            scope.companyId,
            scope.ownerId,
            limit,
            (page - 1) * limit,
        );

        return {
            form_connection_id: formConnectionId,
            leads: rows.slice(0, limit),
            pagination: {
                page,
                limit,
                has_next: rows.length > limit,
            },
        };
    }

}

export default new FacebookLeadService();