# Shopify store connections and event triggers

Customers connect with a store name/domain and Shopify approval. The platform's client
ID/secret stay on the backend. This release connects stores, refreshes offline credentials,
manages selected webhook subscriptions and saves an encrypted event inbox. Optional order
rules queue approved utility WhatsApp templates to consenting customers. Rules are off
until configured by the owner. Campaign creation and chatbot flow execution are separate.

## Shopify app setup

Use a standalone app in the Shopify Dev Dashboard, with **Embed app in Shopify admin**
disabled and the authorization-code/legacy install flow enabled. The development App URL
can be the merchant page at `https://YOUR-API-HOST/v1/integrations/shopify/app`.
Register the exact callback:

```
https://YOUR-API-HOST/v1/integrations/shopify/callback
```

Request `read_orders,read_customers` (or only `read_orders` if customer triggers are not
needed). Use the `2026-10` webhook/API version, matching the server's setting. Release
the app configuration. Existing stores must approve newly requested permissions.

For multiple unrelated customer stores, use a Partner organization and public distribution;
Shopify review and protected customer data approval may be required. Test on a development
store first. A custom distribution app cannot connect arbitrary unrelated merchants.
Do not use the client-credentials grant intended for stores in your own organization.

```
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_REDIRECT_URI=https://YOUR-API-HOST/v1/integrations/shopify/callback
SHOPIFY_FRONTEND_URL=https://YOUR-DASHBOARD-HOST
SHOPIFY_SCOPES=read_orders,read_customers
SHOPIFY_API_VERSION=2026-10
SHOPIFY_TOKEN_ENCRYPTION_KEY=
SHOPIFY_TEST_LOGIN_DOMAIN=
SHOPIFY_EVENT_RETENTION_DAYS=30
SHOPIFY_PRIVACY_CONTROLLER=Soft7
SHOPIFY_PRIVACY_EMAIL=YOUR-PUBLIC-PRIVACY-EMAIL
```

The encryption key must be 32 random bytes encoded as base64, stable across replicas and
restarts. Generate it once using Node crypto. API credentials and this encryption key
belong in `.env`/deployment secret storage, never in `.env.example` or client JavaScript.
Google and Shopify use independent encryption keys. Do not rotate either casually.

Apply `20261016000002_create_shopify.ts` and `20261017000001_shopify_privacy.ts`, build and
restart the API. Both migrations have been applied to the configured development database.
Other deployments need these migrations too. Build copies `src/web/shopify` into
`dist/src/web/shopify`. `npm run check:shopify` checks local settings and build artifacts;
it does not prove live installation, uptime, dashboard configuration or Shopify approval.

WhatsApp rules also require `20261017000002_shopify_whatsapp.ts`, which has been applied
to the configured development database. Other environments need this migration before
the new server/worker code. `npm run start:worker` includes the Shopify message scheduler;
`npm run start:shopify-worker` runs only Shopify messages, without other campaign workers.

## Try the browser connection

Open `/v1/integrations/shopify/app` on the hostname registered for the callback. Sign in
using an RSVPDesk **account owner**. In development, the login domain defaults to
`localhost`; override with `SHOPIFY_TEST_LOGIN_DOMAIN` when needed. Dashboard JWTs stay
in page memory. Shopify credentials are not requested from customers.

Enter the store's bare name or `store.myshopify.com` domain (not a custom storefront URL).
Click Connect Shopify and approve in the popup. The page polls for the successful
connection. The `/test` alias also exposes diagnostic configuration and JWT entry.
If authorization fails, the popup shows Shopify's error; Check connections
stops polling. Each new OAuth start replaces this browser's pending binding cookie.

Select a store, choose triggers, and click Save triggers. The backend creates only one
subscription per store/topic. Trigger selection starts empty. Lifecycle subscriptions
are installed automatically. Create a matching event in the actual store and use Refresh
events to inspect its payload. A Shopify CLI mock delivery alone does not test a real
store subscription. Outbound messages are queued only when an enabled WhatsApp rule and
valid consent/phone data are present.

## Dashboard API

Base path: `/v1/admin/shopify`. All endpoints require an owner dashboard JWT in
`Authorization: Bearer ...`; company/owner identity comes from the JWT, never a body field.

| Method | Path                                                    | Description                                                                     |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/setup`                                                | Public-safe configuration, required scopes and trigger catalogue                |
| POST   | `/oauth/start`                                          | Start authorization, set browser cookie                                         |
| GET    | `/connections`                                          | Stores, scopes, selected/subscribed topics and setup issues; no credentials     |
| PUT    | `/connections/:id/triggers`                             | Save selected topics and synchronize Shopify subscriptions                      |
| POST   | `/connections/:id/sync`                                 | Retry subscription reconciliation                                               |
| DELETE | `/connections/:id`                                      | Remove owned subscriptions and clear stored tokens                              |
| GET    | `/connections/:id/events`                               | Latest 50 event receipts, without customer payloads                             |
| GET    | `/connections/:id/events/:eventId`                      | Decrypted event details, owner access only                                      |
| GET    | `/connections/:id/whatsapp?phone_number_id=UUID`        | Owned sender options, approved utility templates and current rules              |
| PUT    | `/connections/:id/whatsapp/rule`                        | Save or disable the rule identified by body `topic`                             |
| GET    | `/connections/:id/whatsapp/jobs`                        | Last 50 order-message statuses and skip reasons; no recipient payloads          |
| GET    | `/connections/:id/privacy-requests`                     | Requests, pending and overdue counts; account owner only                        |
| GET    | `/connections/:id/privacy-requests/:requestId/export`   | Matching retained data, 200 events per page; use `after=next_cursor` until null |
| POST   | `/connections/:id/privacy-requests/:requestId/complete` | Record explicit merchant-delivery confirmation with `{ "delivered": true }`     |

Start request:

```json
{ "shop": "customer-store.myshopify.com", "name": "Client clothing store" }
```

Use `credentials: 'include'` and open `data.authorization_url` in the same browser. The
callback must receive its browser-binding cookie. For cross-origin UI requests configure
the exact frontend origin; browser restrictions on third-party cookies can still apply.
Prefer dashboard/API hostnames under the same site. Open the test page on the callback
host to avoid unrelated-site cookie restrictions.

Save trigger request:

```json
{ "topics": ["orders/create", "orders/paid", "orders/cancelled"] }
```

Supported topics: `orders/create`, `orders/paid`, `orders/cancelled`, `orders/updated`,
`customers/create`. Abandoned checkout requires a separate polling/delay/recheck workflow
and is not represented as a fictitious immediate webhook topic.

Disconnect removes only subscriptions belonging to this connection's bound destination;
it does not uninstall the Shopify app or release the store to a different tenant.
If Shopify cannot be reached, removal fails visibly and can be retried. If authorization
has already expired, reconnect or uninstall the app from Shopify. Uninstall events clear
tokens automatically. Subscription synchronization is serialized with token refresh and
OAuth acquisition, because these operations can retire one another's tokens.

## Webhook delivery

The API registers a per-connection HTTPS URL:

```
/v1/integrations/shopify/webhook/CONNECTION_UUID/OPAQUE_DELIVERY_TOKEN
```

The destination token is generated by the backend and is never included in store lists.
Do not invent a destination or set it manually in Shopify's Notifications panel; those
admin-created subscriptions use different signing credentials. The registered API
subscriptions use the platform app's client secret.

### Receive-only flow tests from Shopify Admin

The optional test-flow receiver supports manually created Shopify Admin webhooks using
the **store's** signing secret from Settings > Notifications > Webhooks. It does not
replace the app-created delivery endpoints above and does not execute WhatsApp/chatbot
actions. A test flow remains a draft and reserves one Chatbot slot through the existing
plan-usage service.

An account owner can create a test flow with:

```text
POST /v1/admin/shopify/connections/CONNECTION_ID/test-flows
Authorization: Bearer OWNER_JWT
Content-Type: application/json

{"name":"Shopify order webhook test","topic":"orders/create","signing_secret":"STORE_WEBHOOK_SIGNING_SECRET"}
```

The store connection must belong to that owner. Set `topic` to `"*"` for receipt-only
tests of all supported order/customer events plus `carts/create`, `carts/update`,
`checkouts/create`, `checkouts/update` and `checkouts/delete`. A specific topic restricts
that test URL to that event. This is separate from the store's ordinary automation
trigger selection; it never enables a WhatsApp rule or broadens app-created subscriptions.
The secret must be the 64-character store webhook signing value, not an access token or
the app client secret. It is stored encrypted. The response supplies the flow ID and
this actual URL format, including a random destination token:

```text
/v1/integrations/shopify/webhook/flows/FLOW_UUID/DESTINATION_TOKEN
```

In Shopify Admin, create a new webhook, choose the event matching your test flow,
**JSON**, and paste the returned complete HTTPS URL. Use **Send test**. A `"*"` test
flow accepts the supported order, customer, cart and checkout events at the same URL.
Its URL already contains its flow ID; do not replace any segment. Lifecycle and privacy
topics are excluded from these test URLs, so a test cannot uninstall or erase a shop.

POST requests require the exact-body store signature, matching shop and event, active
owner/company/store/flow, and an unexpired URL token. Deliveries are deduplicated and
saved in the same encrypted/minimized inbox with `flow_id`. They participate in the
existing customer export, erasure, retention and shop deletion controls. They never
enqueue WhatsApp jobs, even if the same store has active messaging rules.

Opening the same URL with GET shows accepted events, receipt count, latest event topic
and receipt time, without customer payloads;
`?format=json` returns the same safe receipt metadata. Full retained event data remains
in the account owner's authenticated event inbox. Owner-only
`GET /connections/CONNECTION_ID/test-flows/FLOW_UUID` retrieves the configured URL.
The URL expires after seven days; maintenance then disables it and clears its encrypted
signing secret and destination token. This receiver requires migration
`20261017000003_shopify_flow_webhooks.ts` in addition to the earlier migrations.

The user-requested development test flow was provisioned for the confirmed owner and
updated to accept all supported test events after real Shopify cart/checkout tests were
rejected by its initial order-only configuration. Its URL and expiry were preserved.
Its generated URL and safe sample-verification results are stored locally in ignored
`tmp/shopify-test-flow.json`. A developer-signed sample through ngrok returned 200 and
stored one receipt. Three originally failed Shopify Send test requests (cart creation,
customer creation and checkout update) were replayed with their original signed bodies;
all returned 200 and were stored, with zero WhatsApp jobs. Safe replay evidence is in
ignored `tmp/shopify-test-flow-replay.json`. Keep the capability URL private.

Verification uses the exact raw body, constant-time HMAC comparison, bound destination
and canonical shop domain. Deliveries are deduplicated by connection + Shopify webhook
ID. Inbox payloads are allowlisted to resource/customer IDs, order statuses and canonical
event timestamps, then encrypted. IDs are represented as strings. Names, contact values,
addresses, notes, line items and arbitrary fields are excluded. Tenant-bound keyed hashes
of supplied identifiers and contact values are used solely for privacy request matching.
These hashes are still protected data. Receipt timestamps and delivery IDs
are not an action-execution guarantee: a future action runner must add its own flow/event
idempotency key and durable queue/outbox. Incoming events are stored, not executed.

The webhook returns 200 after database commit. If setup/refresh holds the store lock,
delivery receives an immediate retryable 503 instead of blocking behind network requests.
Keep API/database capacity sufficient for Shopify's five-second delivery timeout.
Webhook API version comes from the Shopify app configuration; keep it aligned with the
backend. If the tunnel hostname changes, update the app callback and env settings and
retry webhook synchronization. Old destinations are removed using saved subscription
records when possible.

Morgan query/path logging is skipped for all public Shopify paths. Configure IIS/CDN/APM
to redact OAuth query strings and the opaque webhook destination token too. Do not log
request bodies, authorization headers or raw Axios errors.

## Privacy and production rollout

Configure Shopify's mandatory `customers/data_request`, `customers/redact`, `shop/redact`
compliance topics to the shared endpoint:

```
https://YOUR-API-HOST/v1/integrations/shopify/webhook
```

This endpoint accepts signed privacy requests with matching shop domain and shop ID;
normal subscribed events must use the bound per-store destination. Customer redaction
queues durable customer erasure work and immediately suppresses matches against that queue.
Matching uses customer IDs, `orders_to_redact` and supplied email/phone hashes, including
legacy payloads. It clears matching inbox contents and identifiers while retaining the
delivery receipt for deduplication. Repeated matching events are ignored for 30 days.
Shop redaction deletes the store record and cascades to sessions, subscriptions, inbox,
privacy requests and access logs. Maintenance also removes uninstalled stores after
48 hours as a fallback when shop redaction is missed.

The API starts privacy maintenance on startup and every minute. Per-store database locks
prevent concurrent privacy, webhook and OAuth changes across replicas. Each pass scrubs
up to 500 legacy raw payloads per store; pending customer erasures run after that store's
legacy scrub completes. Failed stores remain pending and are reported by aggregate
error counts; another store's failure does not prevent maintenance of other accounts.
Monitor the maintenance logs. `npm run shopify:privacy` runs one maintenance pass manually
after building. Run additional passes until legacy scrubbing is complete.

`SHOPIFY_EVENT_RETENTION_DAYS` accepts 1–30, default 30. Expired events are hidden from
ordinary inbox reads and deleted by maintenance. Pending privacy requests hold that
store's event data until fulfilment; this exception is disclosed on the privacy page.
Completed request receipts and suppression hashes expire after 30 days, and data-access
logs after 90 days. Pending requests are not silently deleted on reaching their deadline.
Expired OAuth sessions are removed too. Retention changes apply when events are stored
or legacy events are scrubbed; existing version-1 events keep their original expiry.

Data access requests are kept separately with a 30-day due date. In **Data requests**, the
owner downloads an export that fetches every page of matching retained events, delivers
it securely to the merchant, and clicks **Confirm delivered**. Exporting alone does not
complete a request. The completion endpoint requires both a completed export pass and
explicit delivery confirmation. Export/read/completion operations record the owner and
receipt IDs in a restricted audit table without storing exported contents in that log.
The UI displays pending and overdue counts; refresh it regularly and monitor overdue
maintenance warnings. Merchant delivery is manual; no email or WhatsApp is sent.

The public disclosure is `/v1/integrations/shopify/privacy`. It requires an actual company
name and valid public privacy email; absent settings return 503 instead of publishing
invented contact details. The local setup uses Soft7 and the already configured integration
privacy contact. It describes this integration's implemented processing and is not a full
business-wide privacy agreement or proof of legal compliance.

`shopify.app.review.toml` contains the supplied ngrok URL and the existing app client ID
as a review configuration draft. It has not been released to Shopify. Verify the dashboard
app name and all three compliance subscriptions before release. Keep the public hostname,
API and database available throughout review. Test a real store installation, trigger
delivery, privacy request/export/completion, redaction and uninstall before submission.
The public address and development environment do not establish persistent production
hosting. Reconciliation of missed Shopify events and automatic chatbot/campaign actions remain unimplemented.

## Customer WhatsApp order updates

After signing in at `/v1/integrations/shopify/app`, select a store, save the order event
under **Choose your triggers**, then configure **WhatsApp messages**. Select an active
WhatsApp sending number and an approved **UTILITY** template from the same owned WABA.
The initial release supports text headers/bodies/footers and static buttons. Media headers,
dynamic or quick-reply buttons, marketing templates and customer-name/email variables
are not supported in this order-message feature. Unsupported templates are shown disabled.

Map each template variable to an allowed order field or explicit literal text. Fields are
order ID/number, total, currency, payment/fulfillment status and store name/domain. No
arbitrary JSON paths, addresses, notes or full webhook dumps are persisted for mapping.
Enable and save the rule. It applies to future events only; existing inbox events are
not replayed into messages. Each event has one independently configurable rule.

The merchant must collect customer permission to receive business order messages and
have its storefront write the configured order `note_attributes` consent marker. The
default is `soft7_whatsapp_opt_in`, with value `"true"`. This repository does not contain
the merchant's storefront/theme, so the checkout/cart consent collection must be
integrated there. A phone number, an order, or Shopify SMS marketing status by itself
does not satisfy this implementation's consent gate. The sender also rechecks existing
WhatsApp STOP/opt-out preferences immediately before sending.

Example event fields after the merchant has actually collected consent:

```json
{
  "id": 456,
  "order_number": 77,
  "phone": "+14155552671",
  "customer": { "id": 8 },
  "financial_status": "paid",
  "note_attributes": [{ "name": "soft7_whatsapp_opt_in", "value": "true" }]
}
```

The recipient is the order phone, then customer-record phone, then billing phone. Shipping
phone is never used because it can identify a different recipient. A usable international
`+countrycode` or `00countrycode` number is required; no country is guessed. Missing
consent, missing/redacted/invalid phone or missing order identity produces a visible
skipped receipt. Public apps need approval for the Shopify **Phone** protected field
before relying on it. Name and Email access are not required for the supported mappings.

Example rule body for `PUT /connections/:id/whatsapp/rule`:

```json
{
  "topic": "orders/paid",
  "enabled": true,
  "phone_number_id": "OWNED-PHONE-UUID",
  "template_id": "APPROVED-UTILITY-TEMPLATE-UUID",
  "consent_attribute": "soft7_whatsapp_opt_in",
  "consent_confirmed": true,
  "parameter_mapping": {
    "body.1": { "field": "order_number" },
    "body.2": { "field": "payment_status" }
  }
}
```

Disable using `{ "topic": "orders/paid", "enabled": false }`. Changing or disabling a
rule prevents older queued messages from using the new configuration. Disconnect,
uninstall and customer erasure also stop unsent matching jobs.

The signed Shopify handler commits the event and message job in one PostgreSQL transaction;
it never calls Meta. Recipient, selected order fields and consent receipt are encrypted
in the job. A separate worker polls every five seconds and uses locked claims across
replicas. It rechecks the store, rule revision, approved template, sender ownership,
customer erasure and opt-out before calling the existing WhatsApp message service.
General event payloads continue to exclude raw phone numbers.

Create/paid/cancelled messages are deduplicated per order, topic and rule. Updated messages
are deduplicated using the order's update timestamp and payment/fulfillment state; this
topic can produce frequent notifications and must be selected intentionally. Jobs expire
for sending after one hour. A provider/API timeout or crash can have an uncertain result,
so these attempts are marked **unknown** for reconciliation and never automatically
resent. A stale claim can be reconciled to **sent** if its saved message has a WAMID.
Sent means accepted by Meta, not confirmed delivered; the normal message inbox receives
delivery callbacks. Exactly-once delivery across an external API is not guaranteed.

Privacy exports now include matching message jobs and linked outbound history. Follow
`next_cursor`, then `next_section: "messages"` using `section=messages` and continue until
both are null. The browser downloads all sections before allowing delivery confirmation.
Shopify-derived outbound messages are linked to their source job by `messages.shopify_job_id`.
Customer erasure removes the linked history and scrubs matching job payloads; expiry and
shop deletion cascade through those linked messages. Other independently collected
WhatsApp contacts/conversations are outside this Shopify-source linkage.

Production deployment must run the API, message worker and existing privacy scheduler,
retain a stable encryption key and provide database/backup encryption. Do not claim a
live merchant send or Shopify/Meta approval based only on fixture tests. The privacy
disclosure describes phone use, Meta delivery, consent and outbound history.

References: [Meta opt-in](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in),
[approved templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview),
[Shopify protected customer fields](https://shopify.dev/docs/apps/launch/protected-customer-data).

Production operators must verify database transport security, backup encryption/expiry,
staff access controls, access-log review, incident procedures and merchant agreements.
Application cleanup does not erase external backup copies. Preserve and reapply deletion
requests to restored backups before accepting traffic, and expire backups under the
documented policy. Shopify approval and operational controls are not established by tests.

References: [standalone authorization](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps),
[webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries),
[subscription API](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate),
[privacy requirements](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance).

## Validation

See [the review setup guide](shopify-review-guide.md) for the exact dashboard fields,
private reviewer instructions and current deployment blockers. The
[security operating procedures](shopify-security-operations.md) distinguish implemented
application controls from provider and staff practices that still need evidence.
`npm run check:shopify:review` records public HTTP and database transport checks and
fails while blockers remain. `node scripts/shopify-live-check.cjs` performs read-only
identity/subscription queries against the supplied development store with normal
credential refresh if needed, without querying customer fields or changing subscriptions.

`npm run test:shopify` runs isolated service and HTTP tests with mocked Shopify responses.
`node scripts/shopify-db-check.cjs` verifies the new tables, ownership and delivery
constraints using a temporary schema inside a rolled-back PostgreSQL transaction. It
uses the configured development database and does not call Shopify. Neither test suite
proves the app is approved or that a merchant has completed live authorization.
