import db from '@surefy/database';
import { Knex } from 'knex';
import { createHash, randomUUID, createHmac, timingSafeEqual } from 'crypto';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CustomError } from '@surefy/exceptions/CustomError';
import * as v from '../utils/superAdminValidation';
import * as provider from './creditTopup.provider';
import { markActivityRecorded } from '../utils/activityContext';
import { randomBytes } from 'crypto';
import facebookOauthSessionModel from '../models/facebookOauthSession.model';
import axios from 'axios';
import { decrypt, encrypt } from '../utils/facebook';
import { requireDashboardOrigin, sessionDashboardOrigin } from './dashboardOrigin.service';

export type FacebookFeature = 'leads' | 'messaging';

type OAuthCallbackInput = {
    state: unknown;
    code: unknown;
    denied: boolean;
    cookieHeader: string | undefined;
};

type FacebookSetupResult = {
    feature: FacebookFeature;
    ready: boolean;
    issues: string[];
    callback_url: string | null;
    webhook_url: string | null;
    permissions: string[];
}

type FeatureConfig = {
    appId?: string;
    appSecret?: string;
    loginConfigId?: string;
    webhookVerifyToken?: string;
    callbackPath: string;
    webhookPath: string;
    cookieName: string;
    sessionTable: string;
    permissions: string[];
}

type OAuthScope = {
    companyId: string;
    ownerId: string;
    userId: string;
}



class facebokOAuthService {
    private validateOrigin(value: string | undefined, _name: string): string | null {
        if (!value) return null;

        try {
            const url = new URL(value);

            const allowLocalHttp =
                process.env.NODE_ENV !== 'production' &&
                ['localhost', '127.0.0.1'].includes(url.hostname);

            if (url.protocol !== 'https:' && !allowLocalHttp) return null;

            //FACEBOOK_PUBLIC_URL must be only an origin:
            // https://api.example.com
            if (url.pathname !== '/' || url.search || url.hash) return null;

            return url.origin
        } catch {
            return null
        }
    }

    private readCookie(cookieHeader: string | undefined, cookieName: string) {
        if (!cookieHeader) return undefined;

        const value = cookieHeader
            .split(';')
            .map((item) => item.trim())
            .find((item) => item.startsWith(`${cookieName}=`))
            ?.slice(cookieName.length + 1);

        // Browser token made by randomBytes(32).toString('base64url')
        return value && /^[A-Za-z0-9_-]{43}$/.test(value)
            ? value
            : undefined;
    }

    private async fetchOAuthPages(feature: FacebookFeature, token: string) {
        type CandidatePage = {
            id: string;
            name: string;
            access_token: string;
        };

        const pages = new Map<string, CandidatePage>();
        const seenCursors = new Set<string>();
        let after: string | undefined;

        do {
            const result = await this.oauthGraphGet(
                feature,
                'me/accounts',
                token,
                {
                    fields: 'id,name,access_token',
                    limit: 100,
                    ...(after ? { after } : {}),
                },
            );

            if (!Array.isArray(result.data)) {
                throw new CustomError('Facebook returned invalid Page data.', 502);
            }

            for (const page of result.data) {
                if (
                    typeof page?.id !== 'string' ||
                    !/^\d{1,80}$/.test(page.id) ||
                    typeof page.name !== 'string'
                ) {
                    throw new CustomError('Facebook returned invalid Page data.', 502);
                }

                // Only offer Pages for which Facebook supplied a Page token.
                if (
                    typeof page.access_token !== 'string' ||
                    !page.access_token
                ) {
                    continue;
                }

                pages.set(page.id, {
                    id: page.id,
                    name: page.name,
                    access_token: page.access_token,
                });
            }

            if (!result.paging?.next) break;

            const nextCursor = result.paging.cursors?.after;

            if (
                typeof nextCursor !== 'string' ||
                !nextCursor ||
                seenCursors.has(nextCursor)
            ) {
                throw new CustomError('Facebook returned invalid pagination.', 502);
            }

            seenCursors.add(nextCursor);
            after = nextCursor;
        } while (after);

        return [...pages.values()];
    }

    private async oauthGraphGet(
        feature: FacebookFeature,
        path: string,
        token: string | null,
        params: Record<string, unknown> = {},
    ): Promise<any> {
        const config = this.featureConfig(feature);
        const version = process.env.FACEBOOK_GRAPH_VERSION!;

        try {
            const response = await axios.get(
                `https://graph.facebook.com/${version}/${path}`,
                {
                    headers: token
                        ? { Authorization: `Bearer ${token}` }
                        : {},
                    params: {
                        ...params,
                        ...(token
                            ? {
                                appsecret_proof: createHmac('sha256', config.appSecret!)
                                    .update(token)
                                    .digest('hex'),
                            }
                            : {}),
                    },
                    timeout: 15000,
                    maxRedirects: 0,
                    maxContentLength: 5 * 1024 * 1024,
                },
            );

            if (response.data?.error) {
                throw { response: { status: response.status, data: response.data } };
            }
            if (!response.data) {
                throw new Error('Invalid Facebook response.');
            }

            return response.data;
        } catch (error: unknown) {
            // Never log Axios errors, request parameters, or Meta's free-form text:
            // they can contain authorization codes, tokens, and app secrets.
            const failure = error as { response?: { status?: unknown; data?: { error?: {
                code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown;
            } } } };
            const meta = failure?.response?.data?.error;
            const numeric = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
                ? value : undefined;
            const step = path === 'oauth/access_token'
                ? params.grant_type === 'fb_exchange_token' ? 'long-lived token exchange' : 'authorization code exchange'
                : path === 'debug_token' ? 'token validation' : 'Page discovery';
            const code = numeric(meta?.code);
            console.warn('[Facebook OAuth] Graph request failed', {
                feature, step, app_id: config.appId,
                http_status: numeric(failure?.response?.status), meta_code: code,
                meta_subcode: numeric(meta?.error_subcode),
                fbtrace_id: typeof meta?.fbtrace_id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(meta.fbtrace_id)
                    ? meta.fbtrace_id : undefined,
            });
            throw new CustomError(
                `Facebook ${step} failed${code === undefined ? '' : ` (Meta error ${code})`}. Please connect again.`,
                502,
            );
        }
    }

    private hash(value: string) {
        return createHash('sha256').update(value).digest('hex');
    }

    private randomValue() {
        return randomBytes(32).toString('base64url');
    }

    private async assertCanManage(scope: OAuthScope) {
        if (!scope.companyId || !scope.ownerId || !scope.userId) {
            throw new Error('A valid company user is required.');
        }

        // Start with owner-only connection permission.
        if (scope.userId !== scope.ownerId) {
            throw new Error('Only the account owner can connect Facebook.');
        }
    }

    private featureConfig(feature: FacebookFeature): FeatureConfig {
        if (feature === 'leads') {
            return {
                // Falls back to your current App-1 variable names.
                appId: process.env.FACEBOOK_LEADS_APP_ID || process.env.FACEBOOK_APP_ID,
                appSecret:
                    process.env.FACEBOOK_LEADS_APP_SECRET ||
                    process.env.FACEBOOK_APP_SECRET,
                loginConfigId:
                    process.env.FACEBOOK_LEADS_LOGIN_CONFIG_ID ||
                    process.env.FACEBOOK_PAGES_LOGIN_CONFIG_ID,
                webhookVerifyToken:
                    process.env.FACEBOOK_LEADS_WEBHOOK_VERIFY_TOKEN ||
                    process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN,

                callbackPath: '/v1/facebook/leads/oauth/callback',
                webhookPath: '/v1/facebook/leads/webhook',
                cookieName: 'fb_lead_browser',
                sessionTable: 'facebook_lead_oauth_sessions',

                permissions: [
                    'pages_show_list',
                    'pages_read_engagement',
                    'pages_manage_ads',
                    'leads_retrieval',
                    'pages_manage_metadata',
                ],
            };
        }

        return {
            appId: process.env.FACEBOOK_MESSENGER_APP_ID,
            appSecret: process.env.FACEBOOK_MESSENGER_APP_SECRET,
            loginConfigId: process.env.FACEBOOK_MESSENGER_LOGIN_CONFIG_ID,
            webhookVerifyToken: process.env.FACEBOOK_MESSENGER_WEBHOOK_VERIFY_TOKEN,

            callbackPath: '/v1/facebook/messaging/oauth/callback',
            webhookPath: '/v1/facebook/messaging/webhook',
            cookieName: 'fb_messaging_browser',
            sessionTable: 'facebook_oauth_sessions',

            permissions: [
                'pages_show_list',
                'pages_messaging',
                'pages_manage_metadata',
            ],
        };
    }


    private async handleCallback(
        feature: FacebookFeature,
        input: OAuthCallbackInput,
    ): Promise<string> {
        const config = this.featureConfig(feature);

        const apiOrigin = this.validateOrigin(
            process.env.FACEBOOK_PUBLIC_URL,
            'FACEBOOK_PUBLIC_URL',
        );

        const version = process.env.FACEBOOK_GRAPH_VERSION;

        if (
            !apiOrigin ||
            !/^\d+$/.test(config.appId ?? '') ||
            !config.appSecret ||
            !version ||
            !/^v\d+\.\d+$/.test(version)
        ) {
            throw new CustomError(
                `Facebook ${feature} OAuth configuration is incomplete.`,
                503,
            );
        }

        const browser = this.readCookie(input.cookieHeader, config.cookieName);

        if (
            typeof input.state !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(input.state)
        ) {
            console.warn('[Facebook OAuth] Invalid callback session', {
                feature, reason: 'missing_or_invalid_state',
            });
            throw new HTTP400Error({
                message: 'Facebook authorization state is missing or invalid. Start a new connection using the authorization URL returned by the server.',
            });
        }

        if (!browser) {
            console.warn('[Facebook OAuth] Invalid callback session', {
                feature, reason: 'missing_or_invalid_browser_cookie',
            });
            throw new HTTP400Error({
                message: 'Facebook login session cookie is missing or invalid. Check browser cookie settings and connect again.',
            });
        }

        const stateHash = this.hash(input.state);
        const browserHash = this.hash(browser);

        const session = await facebookOauthSessionModel.claimCallback(
            feature,
            stateHash,
            browserHash,
        );

        if (!session) {
            throw new CustomError(
                'This authorization expired or was already processed. Connect again.',
                409,
            );
        }

        const frontendOrigin = await sessionDashboardOrigin(session);
        const redirect = new URL('/user/integrations/facebook', frontendOrigin);
        redirect.searchParams.set('feature', feature);

        try {
            if (input.denied) {
                throw new CustomError('Facebook authorization was cancelled.', 400);
            }

            if (typeof input.code !== 'string' || !input.code.trim()) {
                throw new CustomError(
                    'Facebook did not return an authorization code.',
                    400,
                );
            }

            // Must exactly match the redirect_uri used by start().
            const callbackUrl =
                `${process.env.FACEBOOK_PUBLIC_URL}${config.callbackPath}`;

            const shortToken = await this.oauthGraphGet(
                feature,
                'oauth/access_token',
                null,
                {
                    client_id: config.appId,
                    client_secret: config.appSecret,
                    redirect_uri: callbackUrl,
                    code: input.code,
                },
            );

            if (
                typeof shortToken.access_token !== 'string' ||
                !shortToken.access_token
            ) {
                throw new CustomError('Facebook did not return a user token.', 502);
            }

            const longToken = await this.oauthGraphGet(
                feature,
                'oauth/access_token',
                null,
                {
                    grant_type: 'fb_exchange_token',
                    client_id: config.appId,
                    client_secret: config.appSecret,
                    fb_exchange_token: shortToken.access_token,
                },
            );

            const token = longToken.access_token;

            if (typeof token !== 'string' || !token) {
                throw new CustomError('Facebook token exchange failed.', 502);
            }

            const inspection = await this.oauthGraphGet(
                feature,
                'debug_token',
                `${config.appId}|${config.appSecret}`,
                { input_token: token },
            );

            const auth = inspection.data;

            if (
                auth?.is_valid !== true ||
                String(auth.app_id) !== config.appId ||
                auth.type !== 'USER' ||
                typeof auth.user_id !== 'string' ||
                !/^\d+$/.test(auth.user_id)
            ) {
                throw new CustomError(
                    'Facebook returned an invalid user authorization.',
                    403,
                );
            }

            const expired = [
                auth.expires_at,
                auth.data_access_expires_at,
            ].some(
                (value) =>
                    value &&
                    (!Number.isFinite(Number(value)) ||
                        Number(value) * 1000 <= Date.now()),
            );

            if (expired) {
                throw new CustomError('Facebook authorization has expired.', 409);
            }

            const granted: string[] = Array.isArray(auth.scopes)
                ? auth.scopes
                : [];

            const missingPermissions = config.permissions.filter((permission) => !granted.includes(permission));
            if (missingPermissions.length) {
                console.warn('[Facebook OAuth] Required permissions missing', {
                    feature, app_id: config.appId, missing_permissions: missingPermissions,
                });
                throw new CustomError(
                    `Required Facebook permissions were not granted: ${missingPermissions.join(', ')}. Check the login configuration and app access approvals, then connect again.`,
                    403,
                );
            }

            const pages = await this.fetchOAuthPages(feature, token);

            if (pages.length === 0) {
                throw new CustomError(
                    'No accessible Facebook Pages were returned. Check your Page access.',
                    409,
                );
            }

            const saved = await facebookOauthSessionModel.finishCallback(
                feature,
                stateHash,
                browserHash,
                {
                    status: 'ready',
                    facebookUserId: auth.user_id,
                    candidatesCiphertext: encrypt(JSON.stringify({
                        pages,
                        dataExpires: auth.data_access_expires_at
                            ? new Date(
                                Number(auth.data_access_expires_at) * 1000,
                            ).toISOString()
                            : null,
                    })),
                },
            );

            redirect.searchParams.set('oauth', saved ? 'ready' : 'failed');
        } catch (error: unknown) {
            // Store only controlled messages, never raw Axios/provider errors.
            const message = error instanceof CustomError
                ? error.message
                : 'Facebook authorization failed. Please connect again.';

            await facebookOauthSessionModel.finishCallback(
                feature,
                stateHash,
                browserHash,
                {
                    status: 'failed',
                    error: message,
                },
            );

            redirect.searchParams.set('oauth', 'failed');
        }

        return redirect.toString();
    }

    async setup(feature: FacebookFeature): Promise<FacebookSetupResult> {
        const config = this.featureConfig(feature);
        const issues: string[] = [];

        const graphVersion = process.env.FACEBOOK_GRAPH_VERSION;
        const apiOrigin = this.validateOrigin(
            process.env.FACEBOOK_PUBLIC_URL,
            'FACEBOOK_PUBLIC_URL'
        )

        if (!/^\d+$/.test(config.appId || '')) {
            issues.push(`${feature}: Facebook App ID is missing or invalid.`);
        }

        if (!config.appSecret || config.appSecret.length < 20) {
            issues.push(`${feature}: Facebook App Secret is missing or invalid.`);
        }

        if (!/^\d+$/.test(config.loginConfigId || '')) {
            issues.push(`${feature}: Facebook Login for Business configuration ID is missing or invalid.`);
        }

        if (!config.webhookVerifyToken || config.webhookVerifyToken.length < 16) {
            issues.push(`${feature}: webhook verify token is missing or too short.`);
        }

        if (!/^v\d+\.\d+$/.test(graphVersion || '')) {
            issues.push('FACEBOOK_GRAPH_VERSION must look like v23.0.');
        }

        if (!apiOrigin) {
            issues.push('FACEBOOK_PUBLIC_URL must be a valid HTTPS origin.');
        }

        const encryptionKey = Buffer.from(
            process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || '', 'base64',
        );

        if (encryptionKey.length !== 32) {
            issues.push(
                'FACEBOOK_TOKEN_ENCRYPTION_KEY must be a based64-encoded 32-byte key.'
            );
        }

        return {
            feature,
            ready: issues.length === 0,
            issues,
            callback_url: apiOrigin ? `${apiOrigin}${config.callbackPath}` : null,
            webhook_url: apiOrigin ? `${apiOrigin}${config.webhookPath}` : null,
            permissions: config.permissions,
        }
    }

    async start(feature: FacebookFeature, scope: OAuthScope, origin: unknown) {
        await this.assertCanManage(scope)
        const frontendOrigin = await requireDashboardOrigin(origin, scope.companyId);

        const setup = await this.setup(feature)

        if (!setup.ready) {
            throw new Error(`Facebook ${feature} setup is incomplete: ${(setup).issues.join(' ')}`)
        }

        const config = this.featureConfig(feature)

        const state = this.randomValue();
        const browser = this.randomValue();
        const now = new Date()
        const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

        // Remove sessions that have expired for every user
        await db(config.sessionTable)
            .where('expires_at', '<', now)
            .delete()

        // One active login per compant owner per feature
        await db(config.sessionTable)
            .where({
                company_id: scope.companyId,
                owner_id: scope.ownerId
            })
            .delete();

        await db(config.sessionTable).insert({
            state_hash: this.hash(state),
            browser_hash: this.hash(browser),
            company_id: scope.companyId,
            owner_id: scope.ownerId,
            frontend_origin: frontendOrigin,
            status: 'started',
            expires_at: expiresAt
        })

        const authorizationUrl = new URL(
            `https://www.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION}/dialog/oauth`,
        )

        authorizationUrl.searchParams.set('client_id', config.appId!);
        authorizationUrl.searchParams.set(
            'redirect_uri',
            `${process.env.FACEBOOK_PUBLIC_URL}${config.callbackPath}`,
        );
        authorizationUrl.searchParams.set('state', state);
        authorizationUrl.searchParams.set('response_type', 'code');

        // Facebook Login for Business configuration.
        authorizationUrl.searchParams.set('config_id', config.loginConfigId!);
        authorizationUrl.searchParams.set(
            'override_default_response_type',
            'true',
        );

        return {
            browser,
            cookieName: config.cookieName,
            authorizationUrl: authorizationUrl.toString(),
            expiresAt,
        };
    }

    async pages(feature: FacebookFeature, scope: OAuthScope, cookieHeder: string | undefined) {
        await this.assertCanManage(scope)

        const config = this.featureConfig(feature);
        const browser = this.readCookie(cookieHeder, config.cookieName)

        //User did not start OAuth in this browser
        if (!browser) {
            return {
                status: 'none',
                error: null,
                pages: []
            }
        }

        const session = await facebookOauthSessionModel.findActive({
            feature,
            companyId: scope.companyId,
            ownerId: scope.ownerId,
            browerHash: this.hash(browser)
        })

        if (!session) {
            return {
                status: 'none',
                error: null,
                pages: [],
            }
        }

        //Meta login is still happening or callback is exchange the code
        if (session.status === 'started' || session.status === 'authorizing') {
            return {
                status: session.status,
                error: null,
                pages: [],
            };
        }

        // Callback failed. Return only the safe stored error.
        if (session.status === 'failed') {
            return {
                status: 'failed',
                error: session.error || 'Facebook authorization failed. Connect again.',
                pages: [],
            };
        }

        //Only ready status can return candidate Pages
        if (session.status !== 'ready' || !session.candidates_ciphertext) {
            return {
                status: session.status,
                error: 'Facebook Page selection is unavailable. Connect again.',
                pages: [],
            }
        }

        const candidates = JSON.parse(
            decrypt(session.candidates_ciphertext),
        );

        return {
            status: 'ready',
            error: null,

            // Never return access_token to frontend
            pages: (candidates.pages || []).map((page: any) => ({
                page_id: String(page.id),
                name: page.name
            }))
        }
    }

    async messagingCallback(input: OAuthCallbackInput): Promise<string> {
      return this.handleCallback('messaging', input);
    }

    async leadsCallback(input: OAuthCallbackInput): Promise<string> {
      return this.handleCallback('leads', input);
    }
}

export default new facebokOAuthService();
