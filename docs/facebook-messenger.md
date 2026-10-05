# Facebook Messenger testing and App Review

## What is implemented

Open **`https://YOUR_HOST/v1/facebook/page`**. This is a separate Messenger workspace served by this API, with the existing SaaS login, Settings → Integrations → Facebook Messenger, and its own Messenger inbox. It does not change the WhatsApp inbox or contact schema.

The backend uses the existing Express routers, JWT middleware, PostgreSQL/Knex migrations, company IDs, account owner IDs and live team permissions. The Next.js dashboard copy outside this repository has a Facebook Marketplace card pointing to `/`; it was inspected but not modified. Point that card at this page when integrating it into your deployed frontend. Do not pass JWTs in that link. This page provides its own login, and the authenticated API can also be called directly from your frontend using its existing Bearer JWT.

Implemented features:

- Actual Facebook-hosted authorization with server-side code exchange. Facebook Login for Business is the default; an explicitly configured classic Facebook Login flow is available for apps using that product.
- Actual `/me/accounts` Page selection; Page token validation and verified `/PAGE_ID/subscribed_apps` subscription.
- One Page belongs to exactly one company/account. Owner-only connection management; owner and authorized team inbox access. Accepted team membership with `inbox`, `messenger` or `facebook-messenger` permission is checked against the database on every request.
- Raw-body HMAC-SHA256 webhook verification; tenant routing using the connected Page ID; message-ID deduplication; echo reconciliation; conversation identity is Page connection plus Page-scoped customer ID.
- Automatic inbox updates by two-second database-backed polling, including after browser sleep or a network interruption. This works across API replicas without depending on WhatsApp socket rooms.
- Text replies through the actual Messenger Send API, using the connected Page token, the stored PSID, and `messaging_type=RESPONSE`. No broadcast or marketing endpoint exists in this integration.
- Pending/sent/failed replies; delivered/read only from webhook receipts. Echoes can confirm a pending reply before its HTTP response arrives, or reconcile an uncertain network result later.
- Enforcement of the 24-hour window from the last customer message. Read receipts, delivery events and outgoing echoes do not reopen it.
- AES-256-GCM token encryption with a required dedicated 32-byte key; no encryption fallback or plaintext-token acceptance. No Facebook tokens or secrets are returned to the browser. OAuth candidate credentials expire in 15 minutes and are erased after Page selection/disconnect or on the next authorization cleanup.
- Local disconnect, attempted Meta unsubscription, reconnect with retained history, explicit deletion of an integration and its history, signed deauthorization and signed Facebook data deletion callbacks.

History begins when this integration receives webhooks. It does not import older Facebook conversations or render attachment contents; non-text messages are labelled. Customer identifiers are PSIDs, rather than names fetched through extra profile permissions.

## Current verification and blockers

The repository implementation can be built and exercised locally. Automated tests use an isolated local PostgreSQL schema and explicit Meta API test fixtures. Optional browser tests use real Chromium against that isolated API. These fixtures are test-only and cannot be selected in the deployed UI.

Session results: the production build passed; all **23 Messenger tests passed with no skips**, including PostgreSQL, HTTP and Chromium tests; all **6 existing account-isolation regression tests passed**. The migration was applied and rolled back in isolated test schemas. The browser checked automatic arrival of the requested text, reply submission, follow-up continuity, duplicate suppression, logout and mobile layout. These results establish repository behavior with controlled API fixtures, not a native Messenger exchange.

**No real Meta authorization or native Messenger round trip has been performed by the coding session.** The existing environment has no `FACEBOOK_*` integration configuration. No Meta App Dashboard session, selected test Page, eligible Meta test account, deployment domain or hosting credentials were provided. No production migrations were run and no deployment was published. Complete the live checklist below before recording or submitting.

Documentation verification on 3 October 2026 was partial: Meta's developer documentation returned access/rate-limit errors. Meta's own Postman Send API documentation and official sample repository were accessible. The user's private App Dashboard was not accessible. The Dashboard labels, configuration eligibility, active Graph version, permission access levels and development-mode account eligibility must be checked in that app. Do not treat this document as evidence that its private settings have been verified.

Primary references:

- [Meta's Send API documentation on Postman](https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api) describes the Page token, Page messaging task, `pages_messaging` and the 24-hour response window.
- [Meta's official webhook and Send API example](https://github.com/fbsamples/messenger-platform-samples/blob/main/quick-start/app.js) demonstrates verification challenges, Page webhook envelopes, PSIDs and replies. Its embedded API version is historical; this implementation requires a version configured for your app.
- [Meta's Page token example](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-ab559ffb-8e2c-4b0a-b43a-5737b6d2f672) demonstrates `/me/accounts`, Page tokens and the `MESSAGING` task. Only its Page-token portion is relevant here.
- Recheck [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/), [permissions](https://developers.facebook.com/docs/permissions/), [Messenger webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks/), [Messenger policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/), and [user data deletion](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/) in your browser before submission.

## Environment and database

Use the new Facebook section in `.env.example`. Keep real secrets in the deployment's secret manager or uncommitted environment file. These values are independent of the existing WhatsApp `META_*` variables.

| Variable | Value to configure |
| --- | --- |
| `FACEBOOK_APP_ID` | The app used for this Messenger integration |
| `FACEBOOK_APP_SECRET` | That app's secret, backend only |
| `FACEBOOK_GRAPH_VERSION` | An active version supported by your App Dashboard, including `v` and `.0`; no outdated default is assumed |
| `FACEBOOK_LOGIN_MODE` | `business` (default), or explicitly `classic` for an app configured with classic Facebook Login |
| `FACEBOOK_LOGIN_CONFIG_ID` | Facebook Login for Business configuration ID, configured to issue a **user access token**, not a system-user token |
| `FACEBOOK_PUBLIC_URL` | Stable HTTPS origin, e.g. `https://support.example.com`, without a path |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | Random backend verification value; enter the same value in Meta's webhook setup |
| `FACEBOOK_TOKEN_ENCRYPTION_KEY` | Base64-encoded 32 random bytes; preserve it across deploys |
| `FACEBOOK_PRIVACY_CONTROLLER` | Actual business/controller name |
| `FACEBOOK_PRIVACY_EMAIL` | Monitored privacy contact address |
| `JWT_SECRET` | Existing SaaS signing secret; the login service and JWT middleware must use the same value |
| `DATABASE_URL` | Existing deployment PostgreSQL database; set it explicitly |

Generate the encryption key locally, then store it securely:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Never record, commit or paste its output in review documentation. Losing/changing it prevents decryption of existing connections; retain the key or reconnect affected Pages.

Deploy the source, configure the environment, and run the existing migration command against the intended deployment database:

```sh
npm ci
npm run build
npm run migrate:latest
npm start
```

In Windows PowerShell use `npm.cmd` if `npm.ps1` is blocked by execution policy. Migration `20261003000002_create_facebook_messenger.ts` creates the integration, OAuth session, conversation, message and deletion confirmation tables. The build copies the page assets to `dist/src/web/facebook`; the Docker build includes this step.

## Stable HTTPS deployment

Use your existing API hosting and a stable domain with a publicly trusted certificate. Configure `FACEBOOK_PUBLIC_URL` to that origin and keep that URL for the entire review period. A local-only server cannot receive Meta webhooks. A short-lived tunnel is insufficient for dependable reviewer testing.

The API origin must serve `/v1/facebook/*`, `/v1/admin/facebook-messenger/*` and the existing `/v1/auth/login`. Keep the page and API on the same origin so OAuth's HttpOnly browser-binding cookie returns to the callback. The cookie uses `Secure` on HTTPS and `SameSite=Lax`. No Page tokens are placed in cookies or browser storage; the SaaS JWT is stored in this tab's session storage.

Use `docs/facebook-messenger.nginx.conf` as an example alongside your existing TLS configuration. Preserve request bodies and query parameters when proxying. Do not record OAuth callback query strings, verification tokens or deletion confirmation URLs in reverse proxy/APM logs. This API skips request logging for `/v1/facebook/*` and suppresses secret-bearing HTTP/database errors in the integration handlers.

Before review, confirm the API process is running continuously; database migrations are applied; privacy endpoints return 200; real external webhook verification works; and the reviewer can sign into the application from a fresh browser session. Populate the broader SaaS policy with actual hosting subprocessors and backup retention. The integration notice describes active-database deletion and does not promise immediate backup erasure.

## Meta App Dashboard setup

Menu labels can differ by app type and Dashboard rollout. Perform these concrete settings in the app whose ID you configured, and verify them in that Dashboard:

1. Open **My Apps → your app**. Enable the Messenger/customer engagement use case or Messenger product available to that app. Confirm that the Facebook Page Messenger API is available. Complete the business association/verification and access-verification tasks that the Dashboard requires for the permissions you will submit.
2. Under **Settings → Basic**, enter the production app domain and website origin. Set the privacy URL and user-data-deletion callback below. Check contact email and the app's required public details. Add a link to the broader SaaS policy if it contains required disclosures beyond the integration notice.
3. Under **Facebook Login for Business → Configurations**, create a Messenger-specific configuration. Choose a **user access token** and Page assets. Include exactly `pages_show_list`, `pages_messaging`, and `pages_manage_metadata` among the requested feature permissions. Select Page messaging and management tasks as required for messaging and webhook subscription. Copy the configuration ID into `FACEBOOK_LOGIN_CONFIG_ID`. Avoid reusing a WhatsApp Embedded Signup configuration. The backend explicitly rejects system-user tokens.
4. Under the login product's **Settings**, enable Web OAuth login and add the exact **Valid OAuth Redirect URI** below. Enable HTTPS/strict redirect matching as provided by the Dashboard. Set the **Deauthorize Callback URL** below. For classic Facebook Login, explicitly set `FACEBOOK_LOGIN_MODE=classic`; the backend requests the same three scopes using the supported OAuth code flow. Do not switch to classic just to bypass an unsupported business configuration.
5. Under **Webhooks → Page**, or **Messenger → API Setup → Configure webhooks**, register the webhook URL and your `FACEBOOK_WEBHOOK_VERIFY_TOKEN`. Meta must receive the correct challenge response.
6. Subscribe the Page object to **`messages`, `message_echoes`, `message_deliveries`, `message_reads`**. No postback, feed, marketing, Instagram or WhatsApp fields are used by this flow. Confirm the Page permits Messenger messages. If other messaging apps are attached, check the Page's **Advanced Messaging / conversation routing** settings and make this support app the receiving app for the test conversation. This implementation does not take thread control from another app or ingest its standby queue.
7. Log into the application as the company/account owner and choose **Connect Facebook Page**. Grant the requested permissions and select the Page asset in Facebook's real dialog. Select the Page again in this workspace's eligible Page list. The backend calls `POST /PAGE_ID/subscribed_apps` and checks `GET /PAGE_ID/subscribed_apps`. Confirm the card actually says **connected**.
8. Open **App Review → Permissions and Features**, or the use case's permission review screen. Check each requested permission's available access level and requirements. Request Advanced Access where the Dashboard requires it to serve customer businesses/non-role users. Provide a recording demonstrating each permission's implemented feature, the use-case description below, and private reviewer-access instructions.

| Setting | Exact URL with your configured origin |
| --- | --- |
| Application / reviewer entry | `https://YOUR_HOST/v1/facebook/page` |
| OAuth redirect URI | `https://YOUR_HOST/v1/facebook/oauth/callback` |
| Webhook callback (GET and POST) | `https://YOUR_HOST/v1/facebook/webhook` |
| Deauthorization callback (POST) | `https://YOUR_HOST/v1/facebook/deauthorize` |
| Privacy notice | `https://YOUR_HOST/v1/facebook/privacy` |
| Data deletion callback (POST) | `https://YOUR_HOST/v1/facebook/data-deletion` |
| Human deletion instructions (GET) | `https://YOUR_HOST/v1/facebook/data-deletion` |
| Deletion result | Generated `https://YOUR_HOST/v1/facebook/data-deletion/status/CONFIRMATION` |

The public callbacks authenticate through OAuth browser-bound state, webhook signatures or Meta's signed requests, rather than SaaS JWTs. The protected integration/inbox API always requires the application's JWT.

## Permission-to-feature and recording mapping

| Requested permission | Implemented use | Evidence in recording |
| --- | --- | --- |
| `pages_show_list` | List eligible managed Pages via `/me/accounts` and let the owner choose the business Page | Real consent, returned Page list and selection |
| `pages_manage_metadata` | Subscribe and verify the selected Page's Messenger webhook fields; attempt unsubscription on disconnect | Connected Page card after actual subscription, followed by a real incoming message |
| `pages_messaging` | Receive customer-initiated Messenger messages and send agent text replies using the Page token | Exact customer message in the dashboard; exact dashboard reply arriving in native Messenger; follow-up in the same thread |

All three are necessary for the self-service Page connection implemented here. Facebook Login's default public profile access may appear in its dialog; the application does not fetch customer profiles or request `email`. It does not request `pages_read_engagement`, `business_management`, Page publishing, advertising or Instagram permissions. It does not call Meta's historical Conversations API, whose permission requirements differ from webhook ingestion.

## Development-mode accounts and Page access

Verify eligibility in your App Dashboard before recording; the coding session could not inspect it:

1. The connecting person needs Page access that includes the **MESSAGING/MESSAGE task** and management capability for subscriptions. In the Page's New Pages Experience or Business Portfolio, inspect the person's assigned tasks/full-control Page access. Page access alone does not prove app-role eligibility.
2. While testing without approved public access, give the connecting Facebook account an app administrator/developer/tester role as allowed by your app, and ensure its invitation is accepted. Keep a separate eligible customer account for native Messenger testing. Check the Messenger product's tester/role requirements for that customer account and accept its invitation too; do not assume any arbitrary Facebook account works in Development mode.
3. Use a Page accessible to those accounts and allowed for testing by your app's business/access configuration. If the Page is unpublished, additional Page-role restrictions apply. A published dedicated test Page with explicit eligible test actors is easier to verify.
4. App-created Facebook Test Users, where available, may have restrictions on Messenger or interaction with real Pages. Confirm the actual accounts can open native Messenger and reach the test Page before the recording. Do not create misleading personal accounts or document Facebook passwords.
5. For reviewer testing, follow the account/test-asset mechanisms offered by the actual App Review form. A reviewer must be able to perform the required flow without assuming they have your private app role or Page password. Explain which Page is already connected for the support test and how Meta-provided reviewer/test actors can exercise authorization if required. Resolve eligibility with the app's review configuration before submission.

## Secure application reviewer access

Create a **dedicated SaaS review company/account** using your existing administrator/company provisioning flow. Connect only the dedicated test Page; do not expose another customer's company. Give a reviewer agent accepted team membership with `inbox` permission if separate agent testing is required. The owner credential is needed for connect/reconnect/disconnect.

Use a unique random SaaS password stored in your organization's password manager. Enter the application URL, SaaS username/password and company login domain **only in Meta App Review's private testing/access credential fields** (or the secure tester-access mechanism offered by that form). Keep them valid during review and rotate/revoke them afterward. Do not put passwords in this document, source control, a public Page, the recording or an emailed/shared plaintext script. Facebook credentials, App Secrets and Page tokens must not be supplied as SaaS reviewer credentials.

No reviewer account was provisioned during this session because the target review company, deployment and credential vault were not supplied. This is an outstanding configuration task, not a seeded login or a hidden bypass.

## Reviewer testing instructions

Supply the configured URL, company domain, test Page name/ID and private SaaS credential fields along with these steps:

1. Open the application URL. Log in with the supplied SaaS account and company login domain.
2. Choose **Settings → Integrations**, then **Facebook Messenger**. The three permission explanations appear beside **Connect Facebook Page**.
3. Choose **Connect Facebook Page**. The browser opens `www.facebook.com` for actual authorization. Use the eligible Meta review/test actor, grant the three required permissions, and select the designated test Page asset. If permissions were already granted, Facebook may show a reconnect/reauthorization screen rather than first-time consent.
4. On return, select the designated Page in the application and choose **Connect selected Page**. Confirm its Page name, Page ID and **connected** status. No connected state is shown unless the subscription API and subsequent verification succeeded.
5. Open native Messenger with an eligible customer/test actor. Open the designated Page's Messenger thread (`https://m.me/PAGE_ID` is linked on the card). Send **“Hello, I need help with my order.”**
6. Return to the application and open **Messenger inbox**. The conversation appears automatically, generally within the polling interval after Meta delivers its webhook. Select it and confirm the exact message.
7. Enter **“Hello! Please share your order number so we can help.”** and choose **Send reply**. Observe pending then Meta-confirmed sent, or an explicit failure. Delivered/read appear only if Meta provides those events.
8. In native Messenger, confirm the exact reply. Send a second message such as **“My order number is 1234.”**
9. Return to the same application conversation. Confirm the second message appears automatically in that thread.
10. Optional: disconnect the Page, verify replies are blocked, then reconnect it and select the same Page. History is retained. **Delete stored integration** permanently removes stored history and releases Page ownership; use it only after finishing the review test.

If a normal reply is blocked because the 24-hour window is closed, send a new customer message in native Messenger. This flow has no out-of-window tag or promotional-message bypass.

## Recording script

Record the real deployed application and native Messenger; hide password entry, browser developer tools, token inspection and secret settings. Do a live rehearsal first.

| Scene | Action | Suggested narration |
| --- | --- | --- |
| 1 | Log into the SaaS with the dedicated business account | “A business agent signs into our customer support application.” |
| 2 | Open Settings → Integrations → Facebook Messenger | “The business can connect its Facebook Page for Messenger support.” |
| 3 | Click Connect; show Facebook's actual authorization and grants | “Facebook asks the Page owner to authorize Page listing, messaging and webhook management.” |
| 4 | Select the test Page; show name, ID and connected status | “We select the business Page. The application verifies its Messenger webhook subscription.” |
| 5 | In native Messenger send “Hello, I need help with my order.” | “The customer initiates a support conversation.” |
| 6 | Open Messenger inbox and select the exact incoming message | “The real customer message arrives in our dashboard without a manual refresh.” |
| 7 | Send “Hello! Please share your order number so we can help.” | “The agent replies through the Messenger Send API within the customer reply window.” |
| 8 | Show that exact reply in native Messenger | “The customer receives the application's reply in Messenger.” |
| 9 | Send a second customer message; show it in the same dashboard thread | “The follow-up stays in the same Page-scoped customer conversation.” |

Previously granted consent may omit the first-time permission screen. Rehearse reconnect, or remove only the dedicated test app authorization and connect again if necessary. Removing authorization may deauthorize connected Pages; restore the test connection before recording. Do not manufacture a consent screen or substitute automated fixtures for the live recording.

## App Review use-case description

Use this only after the deployed flow has passed the live checklist:

> Our SaaS provides customer support for businesses using their Facebook Pages. An authenticated business account owner authorizes Facebook access, views the Pages they manage, and selects a Page. We use pages_show_list to display that selection, pages_manage_metadata to subscribe and verify the Page's Messenger message and receipt webhooks, and pages_messaging to receive customer-initiated messages and send text replies written by authorized support agents. Messages are stored under the connected Page's company/account and Page-scoped customer conversation. The dashboard identifies Messenger conversations and updates automatically. Replies are restricted to the standard 24-hour customer messaging window; delivery and read indicators require corresponding webhook events. Businesses can reconnect, disconnect or delete the integration. We verify webhook signatures, encrypt stored Page tokens, enforce account access, and provide privacy, deauthorization and data-deletion handling. This flow does not initiate unsolicited conversations or send promotional broadcasts.

Do not claim historical inbox import, attachment rendering, customer-profile enrichment, automation, out-of-window messaging or guaranteed Meta approval.

## API reference

All protected endpoints below are under **`/v1/admin/facebook-messenger`** with `Authorization: Bearer <existing SaaS JWT>`. Company/account scope comes from authenticated context; request bodies cannot override it. Responses use `{success, data}`; integration errors use `{success:false, message, code}`.

| Method/path | Purpose/body |
| --- | --- |
| `GET /setup` | Read configuration readiness, permission/field lists and management capability; no secret values |
| `POST /oauth/start` | Owner-only; `{}`; returns `authorization_url`, sets HttpOnly browser cookie |
| `GET /oauth/pages` | Owner-only; reads current cookie-bound authorization result and public Page names/IDs |
| `POST /pages` | Owner-only; `{ "page_id": "META_PAGE_ID" }`; validates token and subscribes |
| `GET /pages` | Scoped cards/statuses without tokens; marks known expiry as reconnect required |
| `POST /pages/CONNECTION_UUID/disconnect` | Owner-only; removes credentials and attempts Meta unsubscription |
| `DELETE /pages/CONNECTION_UUID` | Owner-only; disconnect and delete Page/history |
| `GET /conversations` | Scoped recent conversation list; optional URL-encoded `before` cursor from `next_cursor` |
| `GET /conversations/UUID/messages` | Conversation + 100 recent messages; optional `before` cursor; oldest first in each returned page |
| `POST /conversations/UUID/messages` | `{ "text": "Support reply", "client_request_id": "UUID" }` |

Reuse `client_request_id` when a client loses the HTTP response. Repeating it reads the existing attempt and never sends a second copy. Reusing it for different text is rejected. If the Meta request times out, the UI says its result is unconfirmed and that it may have been sent; check native Messenger before creating a new send attempt. A later matching echo can confirm that same record. The server does not automatically retry non-idempotent Send API calls.

## Verification checklist

Automated tests:

```powershell
# Local, dedicated PostgreSQL only. Each test creates and drops its own schema.
$env:FACEBOOK_TEST_DATABASE_URL='postgres://TEST_USER@127.0.0.1:TEST_PORT/TEST_DATABASE'
# Optional real-browser UI verification:
$env:FACEBOOK_TEST_CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run test:facebook
npm.cmd run build
```

Without `FACEBOOK_TEST_DATABASE_URL`, PostgreSQL/HTTP tests are explicitly skipped and the cryptography/API-client checks still run. Without `FACEBOOK_TEST_CHROME`, the browser test is explicitly skipped. Tests never load the deployment `.env` or use its database credentials. Chrome runs hidden with a separate profile under ignored `.facebook-test-runtime/`; its generated screenshot contains test fixture data and must not be used as App Review evidence.

The tests cover state binding/replay/cancellation, missing grants, encrypted token storage, subscription failure/reconnect, webhook duplicates, conversation continuity, foreign Page routing, company and account isolation, live team access, Page-token/PSID replies, repeat request IDs, API permission failure, token expiry, window closure, early echoes/read receipts, non-regressing receipt states, unconfirmed sends, disconnect/reconnect, deletion cascades, actual raw-body HTTP verification, JWT guards and migration rollback.

Before recording, complete these **real Meta tests** and retain evidence privately:

- [ ] Verify actual Dashboard configuration, active API version, three permission grants and eligible test actors.
- [ ] Connect through actual Facebook consent; verify the Page appears and subscription succeeds.
- [ ] Complete the exact inbound/outbound/second-message sequence in native Messenger and the dashboard.
- [ ] Confirm native delivery/read events, if emitted, produce those labels; API success alone must show only sent.
- [ ] Cancel actual consent; decline a required grant; revoke Facebook authorization; reconnect after each.
- [ ] Disconnect, send another native customer message and confirm no new ingestion; reconnect and verify resumed messages/history. Events sent while unsubscribed are not backfilled.
- [ ] Re-deliver a real captured signed webhook in a private test environment and confirm no duplicate. Never publish the payload or App Secret.
- [ ] Sign in as a separate SaaS company and as another owner in the same company; verify neither can list, read, send, disconnect or delete the first account's resources.
- [ ] Check stable external HTTPS access, privacy pages, deletion callback configuration and private reviewer login.

Repository completion and passing automated tests do not establish live Meta behavior or guarantee App Review approval.
