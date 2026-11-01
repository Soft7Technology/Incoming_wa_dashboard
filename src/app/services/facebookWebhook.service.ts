import { CustomError } from '@surefy/exceptions/CustomError';
import axios from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import db from '@surefy/database';
import { decrypt, verifySignature } from '../utils/facebook';
import facebookLeadPageModel from '../models/facebookLeadPage.model';
import facebookLeadFormModel from '../models/facebookLeadForm.model';
import facebookLeadModel, {
    FacebookLeadInput,
} from '../models/facebookLead.model';
import facebookMessageModel from '../models/facebookMessage.model';

type VerifyWebhookInput = {
    mode: unknown;
    verifyToken: unknown;
    challenge: unknown;
};

type LeadNotification = {
    pageId: string;
    formId: string;
    leadId: string;
};

type LeadDetails = FacebookLeadInput & {
    form_id: string;
};


function isRecord(
    value: unknown,
): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function isFacebookId(value: unknown): value is string {
    return typeof value === 'string' && /^\d{1,80}$/.test(value);
}

function readSharedEmail(message: Record<string, unknown>) {
    const candidates = [
        { value: isRecord(message.quick_reply) ? message.quick_reply.payload : undefined, source: 'quick_reply' as const },
        { value: message.text, source: 'message_text' as const },
    ];
    for (const { value, source } of candidates) {
        if (typeof value !== 'string') continue;
        const email = value.trim();
        // Accept only a standalone address, never email mentions in a sentence.
        if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) continue;
        const [local, domain] = email.split('@');
        if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
            domain.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) continue;
        return { email: `${local}@${domain.toLowerCase()}`, source };
    }
    return undefined;
}

class FacebookWebhookService {
    private async processLead(
        event: LeadNotification,
        secret: string,
    ): Promise<void> {
        const page = await facebookLeadPageModel.findByFacebookId(event.pageId);

        // Subscription confirmation may still be in flight. Do not acknowledge
        // a notification before the connection can import it.
        if (page?.status === 'pending_subscription') {
            throw new CustomError('Facebook Page subscription is still pending. Retry delivery.', 503);
        }
        // Unknown or disconnected Pages are intentionally ignored.
        if (!page || page.status !== 'connected') return;

        const form = await facebookLeadFormModel.findForWebhook(
            page.id,
            event.formId,
        );

        // Only saved, enabled forms import leads.
        if (!form || !form.enabled) return;

        if (await facebookLeadModel.exists(form.id, event.leadId)) return;

        if (!page.token_ciphertext) {
            throw new CustomError('The connected Page has no stored token.', 503);
        }

        let token: string;

        try {
            token = decrypt(page.token_ciphertext);
        } catch {
            throw new CustomError('Unable to read the Facebook Page credentials.', 503);
        }

        // Fetch before starting the database transaction.
        const lead = await this.fetchLead(event, token, secret);

        await db.transaction(async (trx) => {
            // Lock Page first, matching your sync/disconnect workflows.
            const currentPage = await facebookLeadPageModel
                .findByScope(page.id, page.company_id, page.owner_id, trx)
                .forUpdate();

            if (!currentPage || currentPage.status !== 'connected') return;

            if (
                currentPage.page_id !== event.pageId ||
                currentPage.token_ciphertext !== page.token_ciphertext ||
                String(currentPage.updated_at) !== String(page.updated_at)
            ) {
                throw new CustomError(
                    'The Page connection changed while processing the webhook.',
                    503,
                );
            }

            const currentForm = await facebookLeadFormModel
                .findForWebhook(page.id, event.formId, trx)
                .forUpdate();

            if (
                !currentForm ||
                !currentForm.enabled ||
                currentForm.id !== form.id
            ) {
                return;
            }

            await facebookLeadModel.insertIfMissing(
                trx,
                currentForm.id,
                lead,
            );
        });
    }

    private async fetchLead(
        event: LeadNotification,
        token: string,
        secret: string,
    ): Promise<LeadDetails> {
        const version = process.env.FACEBOOK_GRAPH_VERSION;

        if (!version || !/^v\d+\.\d+$/.test(version)) {
            throw new CustomError('Facebook Graph API version is not configured.', 503);
        }

        let lead: LeadDetails;

        try {
            const response = await axios.get<LeadDetails>(
                `https://graph.facebook.com/${version}/${event.leadId}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                    params: {
                        fields: 'id,form_id,created_time,field_data',
                        appsecret_proof: createHmac('sha256', secret)
                            .update(token)
                            .digest('hex'),
                    },
                    timeout: 10000,
                    maxRedirects: 0,
                    maxContentLength: 1024 * 1024,
                },
            );

            lead = response.data;
        } catch {
            // Never expose Axios errors containing tokens or lead data.
            // Do not acknowledge successful receipt when retrieval failed.
            throw new CustomError(
                'Unable to retrieve the notified Facebook lead.',
                503,
            );
        }

        if (
            !lead ||
            lead.id !== event.leadId ||
            lead.form_id !== event.formId ||
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
                'Facebook returned invalid or mismatched lead data.',
                502,
            );
        }

        return lead;
    }

    verifyLeads(input: VerifyWebhookInput): string {
        const expectedToken =
            process.env.FACEBOOK_LEADS_WEBHOOK_VERIFY_TOKEN ||
            process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN;

        if (!expectedToken) {
            throw new CustomError(
                'Facebook Leads webhook verification is not configured.',
                503,
            );
        }

        if (
            typeof input.mode !== 'string' ||
            typeof input.verifyToken !== 'string' ||
            typeof input.challenge !== 'string' ||
            !input.verifyToken ||
            !input.challenge
        ) {
            throw new CustomError(
                'Invalid webhook verification parameters.',
                400,
            );
        }

        if (input.mode !== 'subscribe') {
            throw new CustomError(
                'Unsupported webhook verification mode.',
                403,
            );
        }

        const supplied = Buffer.from(input.verifyToken, 'utf8');
        const expected = Buffer.from(expectedToken, 'utf8');

        if (
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)
        ) {
            throw new CustomError(
                'Webhook verification failed.',
                403,
            );
        }

        return input.challenge;
    }

    async receiveLeads(
        rawBody: Buffer | undefined,
        signature: string | undefined,
    ): Promise<void> {
        const secret =
            process.env.FACEBOOK_LEADS_APP_SECRET ||
            process.env.FACEBOOK_APP_SECRET;

        if (!secret) {
            throw new CustomError('Facebook Leads app secret is not configured.', 503);
        }

        if (!Buffer.isBuffer(rawBody)) {
            throw new CustomError('Webhook raw-body capture is not configured.', 503);
        }

        if (!verifySignature(rawBody, signature, secret)) {
            throw new CustomError('Invalid Facebook webhook signature.', 403);
        }

        let payload: any;

        try {
            payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
            throw new CustomError('Invalid webhook JSON.', 400);
        }

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new CustomError('Invalid webhook payload.', 400);
        }

        // This receiver handles Page events only.
        if (payload.object !== 'page') return;

        if (!Array.isArray(payload.entry)) {
            throw new CustomError('Invalid webhook entries.', 400);
        }

        const notifications = new Map<string, LeadNotification>();

        for (const entry of payload.entry) {
            if (!entry || typeof entry !== 'object') {
                throw new CustomError('Invalid webhook entry.', 400);
            }

            // Page webhooks may also contain unrelated event types.
            if (entry.changes === undefined) continue;

            if (!Array.isArray(entry.changes)) {
                throw new CustomError('Invalid webhook changes.', 400);
            }

            for (const change of entry.changes) {
                if (change?.field !== 'leadgen') continue;

                const value = change.value;
                const pageId = value?.page_id ?? entry.id;
                const formId = value?.form_id;
                const leadId = value?.leadgen_id;

                if (
                    ![pageId, formId, leadId].every(
                        (id) => typeof id === 'string' && /^\d{1,80}$/.test(id),
                    ) ||
                    pageId !== entry.id
                ) {
                    throw new CustomError('Invalid lead notification identifiers.', 400);
                }

                notifications.set(`${pageId}:${formId}:${leadId}`, {
                    pageId,
                    formId,
                    leadId,
                });
            }
        }

        for (const notification of notifications.values()) {
            await this.processLead(notification, secret);
        }
    }

    verifyMessaging(input: VerifyWebhookInput): string {
        const expectedToken = process.env.FACEBOOK_MESSENGER_WEBHOOK_VERIFY_TOKEN;

        if (!expectedToken) {
            throw new CustomError(
                'Facebook Messenger webhook verification is not configured.',
                503
            )
        }

        if (
            typeof input.mode !== 'string' ||
            typeof input.verifyToken !== 'string' ||
            typeof input.challenge !== 'string' ||
            !input.verifyToken ||
            !input.challenge
        ) {
            throw new CustomError(
                'Invalid webhook verification parameters.',
                400,
            );
        }

        if (input.mode !== 'subscribe') {
            throw new CustomError(
                'Unsupported webhook verification mode.',
                403,
            );
        }

        const supplied = Buffer.from(input.verifyToken, 'utf8');
        const expected = Buffer.from(expectedToken, 'utf8');

        if (
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)
        ) {
            throw new CustomError(
                'Webhook verification failed.',
                403,
            );
        }

        return input.challenge;
    }

    async receiveMessaging(
        rawBody: Buffer | undefined,
        signature: string | undefined,
    ): Promise<void> {
        const secret = process.env.FACEBOOK_MESSENGER_APP_SECRET;

        if (!secret) {
            throw new CustomError(
                'Messenger App Secret is not configured.',
                503,
            );
        }

        if (!Buffer.isBuffer(rawBody)) {
            throw new CustomError(
                'Messenger webhook raw-body capture is not configured.',
                503,
            );
        }

        if (!verifySignature(rawBody, signature, secret)) {
            throw new CustomError(
                'Invalid Messenger webhook signature.',
                403,
            );
        }

        let payload: unknown;

        try {
            payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
            throw new CustomError('Invalid webhook JSON.', 400);
        }

        if (!isRecord(payload)) {
            throw new CustomError('Invalid webhook payload.', 400);
        }

        if (payload.object !== 'page') return;

        if (!Array.isArray(payload.entry)) {
            throw new CustomError('Invalid webhook entries.', 400);
        }

        for (const entry of payload.entry) {
            if (!isRecord(entry) || !isFacebookId(entry.id)) {
                throw new CustomError('Invalid Page entry.', 400);
            }

            // Other Page subscriptions may use entry.changes.
            if (entry.messaging === undefined) continue;

            if (!Array.isArray(entry.messaging)) {
                throw new CustomError('Invalid messaging events.', 400);
            }

            for (const event of entry.messaging) {
                if (!isRecord(event)) {
                    throw new CustomError('Invalid messaging event.', 400);
                }

                // Receipts and postbacks require separate handlers.
                if (event.message === undefined) continue;

                if (!isRecord(event.message)) {
                    throw new CustomError('Invalid message payload.', 400);
                }

                const message = event.message;

                // Never treat Page-sent messages as customer messages.
                if (message.is_echo === true) continue;

                const sender = event.sender;
                const recipient = event.recipient;

                if (
                    !isRecord(sender) ||
                    !isFacebookId(sender.id) ||
                    !isRecord(recipient) ||
                    recipient.id !== entry.id ||
                    typeof message.mid !== 'string' ||
                    message.mid.length === 0 ||
                    message.mid.length > 255 ||
                    typeof event.timestamp !== 'number' ||
                    !Number.isSafeInteger(event.timestamp) ||
                    event.timestamp <= 0
                ) {
                    throw new CustomError(
                        'Invalid message identifiers or timestamp.',
                        400,
                    );
                }

                const eventAt = new Date(event.timestamp);

                if (!Number.isFinite(eventAt.getTime())) {
                    throw new CustomError('Invalid message timestamp.', 400);
                }

                if (
                    message.text !== undefined &&
                    typeof message.text !== 'string'
                ) {
                    throw new CustomError('Invalid message text.', 400);
                }

                if (
                    message.attachments !== undefined &&
                    !Array.isArray(message.attachments)
                ) {
                    throw new CustomError('Invalid message attachments.', 400);
                }

                await facebookMessageModel.saveIncoming({
                    pageId: entry.id,
                    senderId: sender.id,
                    messageId: message.mid,
                    text: typeof message.text === 'string' ? message.text : '',
                    eventAt,
                    payload: message,
                    sharedEmail: readSharedEmail(message),
                });
            }
        }
    }
}

export default new FacebookWebhookService();
