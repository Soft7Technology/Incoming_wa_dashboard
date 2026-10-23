# Separate automation flow builder

This API backs the dashboard's **Flows** page. New flows start empty. An executable flow has one webhook trigger followed by up to 19 ordered integration actions. It is independent of the chatbot builder and of the existing receive-only Shopify chatbot test flows.

All dashboard APIs use `/v1/admin/flows` and the existing login JWT:

```http
Authorization: Bearer <login-JWT>
Content-Type: application/json
```

The server saves `user_id` and `company_id` from the authenticated account. A user cannot select someone else's account by adding a user ID to the URL, query, or body. Active `user`, `admin`, and legacy `company` accounts can manage their own flows; members/viewers cannot manage an owner's integration credentials. Shopify/Google's existing OAuth setup routes additionally require the `user` account-owner role.

JSON responses follow `{ success, message, data, meta: { timestamp } }`. The public provider webhook uses `{ success, data }`.

## Flow and connection APIs

Paths below are relative to `/v1/admin/flows`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/apps` | App catalog, supported triggers/actions, parameter schemas and connection setup paths |
| GET | `/connections` | Current user's Shopify, Google Sheets and Razorpay connection choices; credentials are excluded |
| POST | `/connections` | Connect Shopify using client ID/secret, or create a user-owned Razorpay connection |
| DELETE | `/connections/:connectionId` | Disconnect a Razorpay automation connection |
| POST | `/` | Create a named draft with `steps: []` and a webhook URL; no default nodes |
| GET | `/?page=1&limit=20` | Paginated flow list; optional `status` and `search` |
| GET | `/:flowId` | Retrieve complete flow, steps and webhook URL |
| PATCH | `/:flowId` | Rename a flow |
| DELETE | `/:flowId` | Soft-delete a flow, stop future reception and cancel queued runs |
| PUT | `/:flowId/steps` | Save/reorder the complete ordered step array atomically |
| POST | `/:flowId/steps` | Add a trigger at the start or append an action; specify `type` |
| PATCH | `/:flowId/steps/:stepId` | Configure one existing step |
| DELETE | `/:flowId/steps/:stepId` | Remove any node and reconnect neighbors; removing the trigger clears webhook configuration |
| PATCH | `/:flowId/status` | Activate/deactivate: `{ "status": "active" }` or `{ "status": "inactive" }` |
| POST | `/:flowId/webhook` | Configure provider signing secret; optionally rotate the webhook URL token |
| POST | `/:flowId/webhook/subscribe` | Automatically register the selected Shopify event and configure app-secret signature verification; optional `{ "revision": 3 }` |
| GET | `/:flowId/webhook/status` | Check the Shopify app subscription and whether this flow verifies with the app secret |
| DELETE | `/:flowId/webhook/subscription` | Remove app-owned subscriptions for this flow and clear its saved signing configuration; optional revision |
| GET | `/:flowId/events` | Latest 50 verified matching webhook receipts, newest first |
| GET | `/:flowId/events/:eventId` | Authenticated access to one captured trigger payload |
| POST | `/:flowId/test-runs` | Queue the configured actions against a captured event |
| GET | `/:flowId/runs` | Latest 50 execution summaries |
| GET | `/:flowId/runs/:runId` | Execution status and per-action results |

Use the returned UUIDs in all routes and references. The 24-character Mongo-style IDs in the supplied reference example are not IDs in this PostgreSQL API. Responses provide both `id` and `_id` for flows, and `_id` for steps.

Flow list `data`:

```json
{
  "items": [],
  "pagination": { "page": 1, "limit": 20, "total": 0 },
  "counts": { "all": 0, "active": 0, "inactive": 0, "draft": 0 }
}
```

Supported statuses are `draft`, `active`, and `inactive`. Maximum page size is 100. Counts cover the user's entire non-deleted flow collection, independently of list filters.

## Create and configure the reference flow

### 1. Create flow

`POST /v1/admin/flows`

```json
{ "name": "Shopify new order to Google Sheets" }
```

HTTP 201; representative `data`:

```json
{
  "id": "20000000-0000-4000-8000-000000000001",
  "_id": "20000000-0000-4000-8000-000000000001",
  "user_id": "<authenticated-user-UUID>",
  "company_id": "<authenticated-company-UUID>",
  "name": "Shopify new order to Google Sheets",
  "status": "draft",
  "revision": 1,
  "webhookConfigured": false,
  "webhookPath": "https://YOUR-API-HOST/v1/webhook/flows/20000000-0000-4000-8000-000000000001/<private-token>",
  "steps": []
}
```

Actual steps also include `createdAt` and `updatedAt`, and every step has the authenticated ownership and flow fields. Webhook signing-secret configuration is required before the URL accepts events.

### 2. Select connections and steps

Get `/apps` for the catalog and `/connections` for the account's connection IDs. Add the trigger with `POST /:flowId/steps`:

```json
{
  "revision": 1,
  "type": "trigger",
  "appKey": "shopify",
  "key": "new_order",
  "connectionId": "<Shopify-connection-UUID>",
  "parameters": {}
}
```

Add the action with `POST /:flowId/steps`, using the latest returned revision:

```json
{
  "revision": 2,
  "type": "action",
  "appKey": "google-sheets",
  "key": "createSpreadsheet",
  "connectionId": "<Google-Sheets-connection-UUID>",
  "parameters": {
    "title": "New Shopify order {{trigger.id}}",
    "sheet_title": "Order"
  }
}
```

`revision` is an optional optimistic concurrency check on edits, webhook configuration and status changes. Supply the latest revision to detect stale editor saves. A mismatch returns 409. Structural edits and webhook-secret changes require a draft/inactive flow; deactivate first if active.

For complete saves, use `PUT /:flowId/steps` with `{ "revision": 3, "steps": [...] }`. Keep the array in execution order. Preserve existing `_id` values; omit `_id` for a new step to let the server assign one. Draft/inactive flows may be empty or temporarily contain only actions. A trigger, when present, must be the first and only trigger. Activation and test runs require a configured trigger and at least one action. The server calculates `nextStepId` from array order and computes each step's `complete`/`incomplete` status. Client-supplied ownership, `flowId`, status, webhook URLs and `nextStepId` do not override those values.

Delete a node with `DELETE /:flowId/steps/:stepId`, optionally passing `{ "revision": <latest> }`. Replace the editor's entire step array with the returned `data.steps`. Neighbors are reconnected automatically. Deleting the last node leaves `steps: []`; no replacement nodes are generated. Deleting a trigger preserves the remaining actions and clears its signing secret. Add a replacement trigger with `POST /:flowId/steps` and `type: "trigger"`; it is prepended, then needs webhook configuration again. A second trigger returns 409. Missing nodes return 404. Existing flows keep their saved nodes until explicitly edited.

If `type` is omitted on POST, an empty flow gets a trigger and a nonempty flow gets an action. Send an explicit type from the UI. Deleting a node does not rewrite downstream data mappings: remap references to removed outputs before running. Structural edits to an active flow return 409; deactivate before editing.

### 3. Register a Shopify webhook automatically (recommended for customer stores)

There are two supported connection methods. Both register a single webhook for the flow's trigger. Adding action nodes never creates additional webhook subscriptions.

**Customer's own app credentials:** Open an Add Shopify Connection form with Name, Store domain, Client ID and Client Secret (password input). Submit:

```http
POST /v1/admin/flows/connections
Authorization: Bearer <login-JWT>
Content-Type: application/json
```

```json
{
  "appKey": "shopify",
  "name": "My store",
  "shop": "my-store.myshopify.com",
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET"
}
```

Shopify permits this token grant only when the app and store belong to the same Shopify organization and the app is already installed with the required scopes. A customer can enter their own qualifying app/store pair. It cannot connect unrelated stores using the platform app credentials. See [Shopify's client credentials requirements](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).

HTTP 201 returns `data.id`, `_id`, `appKey`, `name`, `shop_domain`, `status`, `authentication: "client_credentials"`, `client_id`, `credentials_configured: true`, `token_expires_at`, and `scopes`. Save `data.id` as the trigger's `connectionId`. The backend validates the store identity and exchanges credentials; secrets and access tokens are encrypted and never returned. Expiring tokens are reissued on demand before Shopify API calls, rather than on every incoming event. The existing `SHOPIFY_TOKEN_ENCRYPTION_KEY` is required.

`GET /v1/admin/flows/connections` returns a `data` array with safe connection metadata, including `authentication` and (for this mode) `client_id`/`credentials_configured`. Show table columns Name, Store, Client ID, Secret (Saved), Status, and Select. Never put the secret in table data, browser storage or step parameters. Re-submitting the same shop/client ID reconnects the existing credential connection. Switching an actively connected store to another app or from OAuth returns 409; remove its flow subscriptions and disconnect first using `DELETE /v1/admin/shopify/connections/:connectionId`.

**Platform OAuth:** The operator configures `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI`, encryption key and scopes on the backend once. Each customer uses `POST /v1/admin/shopify/oauth/start` with `{ "shop": "customer.myshopify.com" }`, then approves the returned authorization URL. This supports stores belonging to other merchants without requesting their app credentials. Preserve this alternative when a client-credentials connection is refused by Shopify.

Once the flow has a Shopify trigger and the customer's authorized `connectionId`, call:

```http
POST /v1/admin/flows/:flowId/webhook/subscribe
Authorization: Bearer <login-JWT>
Content-Type: application/json
```

```json
{ "revision": 3 }
```

Only `revision` is accepted. The backend saves the selected connection's app secret encrypted for this flow's HMAC verification, gets/refreshes the store's access token, then calls Shopify's `webhookSubscriptionCreate` with the selected topic and generated flow URL. For a client-credential connection this is its saved client secret; for platform OAuth it is the configured platform app secret. The browser does not supply a second signing secret, destination URL, app credentials or access token to this subscribe endpoint. Response `data`:

```json
{
  "subscribed": true,
  "topic": "carts/update",
  "webhookPath": "https://YOUR-API-HOST/v1/webhook/flows/FLOW_UUID/PRIVATE_TOKEN",
  "subscription_id": "gid://shopify/WebhookSubscription/123456789",
  "reused": false,
  "signing_secret_configured": true,
  "authentication": "shopify_app",
  "revision": 4
}
```

The API is repeatable: it reuses a matching subscription and removes duplicate or obsolete app-owned subscriptions for this flow only. A changed topic, URL or destination token needs another subscribe call. Other flows and the integration's shared subscriptions are preserved. Structural setup requires a draft/inactive flow. A 409 means reload the latest revision and retry. The webhook signing configuration is saved before registration so early deliveries can be authenticated. A provider failure can leave signing configured without a remote subscription; retry subscribe or inspect status. A successful credential refresh is committed even when subscription setup fails, so the refresh token is not lost through transaction rollback.

`GET /:flowId/webhook/status` returns `subscribed`, `subscription_id`, `matching_subscriptions`, `topic`, `webhookPath`, `signing_secret_configured`, `authentication`, `ready` and `revision`. `ready` is true only when the matching remote subscription exists and the saved verification secret is the current app secret. This call checks Shopify and can refresh expiring credentials; it is not intended as a high-frequency listening poll. Use `/events` to listen for deliveries. Access tokens are refreshed when Shopify API work needs them, not every time a webhook arrives. Webhook deliveries use HMAC authentication independently of API access-token expiry.

For this mode, create/update a real online-store cart to test `carts/update`, or perform the matching store event. Shopify Settings > Notifications > Send test belongs to manually created store webhooks and uses that store's signing secret; it is not a test sender for this app-owned subscription. Do not switch the app-connected flow back to the manual store secret to accept that unrelated test. Cart webhooks require `read_orders` and apply to Online Store carts, not all custom storefront carts.

Before deleting an automatically subscribed flow, call `DELETE /:flowId/webhook/subscription`, then delete the flow. The delete-subscription call removes this app's matching flow destinations, leaves other flow subscriptions alone and clears local signing configuration. Deactivate first when active. Existing manually configured dashboard webhooks are not managed through Shopify's app-scoped subscription API; manage those in Shopify separately. Do not rotate the Shopify app secret or return raw credentials from a frontend token-generation endpoint.

Automatic registration is currently implemented for Shopify. Razorpay still uses the existing encrypted key connection plus manual webhook configuration below; API key secrets and webhook signing secrets are different credentials.

### Manual webhook setup (Razorpay or Shopify store-dashboard tests)

`POST /:flowId/webhook`:

```json
{
  "signing_secret": "<provider-webhook-signing-secret-at-least-16-characters>",
  "revision": 3
}
```

Response `data` contains `webhookPath`, `signing_secret_configured`, `revision`, and the selected provider `topic`.

For **Shopify**, create a JSON webhook in the store's webhook settings for the selected event, paste `webhookPath`, and save the store's manual webhook signing secret here. This secret can differ from the Shopify OAuth app secret. The request must carry the matching `X-Shopify-Shop-Domain`, `X-Shopify-Topic`, and valid `X-Shopify-Hmac-Sha256`.

For **Razorpay**, add the URL to the connected merchant's dashboard in the selected test/live mode, select the matching event, and configure the same webhook secret in both places. The receiver checks `X-Razorpay-Signature` against the original body and reads the topic from `payload.event`.

The backend generates the receiver URL. In manual mode, register it in the provider dashboard. Creating a flow alone does not register a subscription; Shopify's automatic mode uses the subscribe API above. Each flow selects one supported trigger. A different configured trigger can use another flow and its own URL.

Send the provider's test event, poll `GET /:flowId/events`, and retrieve its payload with `GET /:flowId/events/:eventId`. Draft and inactive flows capture verified matching events without running actions. Wrong-topic deliveries return HTTP 200 with `ignored: true`. Invalid signatures are rejected. Webhook bodies are limited to 1 MB; receipt payloads and run results are encrypted at rest.

Add `"rotate_token": true` when configuring a webhook to replace its destination token. The old URL immediately stops working; update the provider dashboard with the new URL. Changing the trigger identity/app/key/connection, or deleting it, clears its saved signing secret and requires configuration again.

### 4. Add subsequent actions and mappings

`POST /:flowId/steps` appends an action. Example: append a row to the spreadsheet created by the earlier action:

```json
{
  "appKey": "google-sheets",
  "key": "appendRows",
  "connectionId": "<Google-Sheets-connection-UUID>",
  "parameters": {
    "spreadsheet_id": "{{steps.20000000-0000-4000-8000-000000000003.spreadsheetId}}",
    "range": "Order!A1:B",
    "values": [["Shopify order", "{{trigger.id}}"]]
  }
}
```

Mapping syntax:

- `{{trigger.id}}`: a field in the captured provider JSON.
- `Order {{trigger.id}}`: interpolate a scalar into text.
- `{{trigger.payload.payment.entity.amount}}`: nested Razorpay amount in paise.
- `{{steps.STEP_UUID.spreadsheetId}}`: output from an earlier action.
- `{{contact.phone}}`: normalized international buyer phone derived from a Shopify event, or null if missing/invalid. Add the event detail's `contact` object as a separate mapping group in the frontend.
- `{{contact.name}}`: Shopify customer first and last name joined with a space, or null when Shopify does not supply a name. Use this for a spreadsheet customer-name cell so orders without customer details still append successfully.
- A whole-value mapping preserves numbers, booleans and arrays. Mixed text interpolation produces a string.
- Mapping does not evaluate JavaScript or arithmetic. Missing fields and forbidden prototype paths fail validation/execution.

Shopify event detail (`GET /:flowId/events/:eventId`) preserves the original provider JSON in `data.payload` and adds `data.contact`:

```json
{
  "phone": "+12025550123",
  "phone_source": "customer.phone",
  "phone_status": "available",
  "shipping_phone": null,
  "shipping_phone_status": "missing"
}
```

The buyer number is the first valid international number from `payload.phone`, `payload.customer.phone`, then `payload.billing_address.phone`. A shipping address number is exposed separately because it can belong to another recipient. Numbers are normalized to E.164; country codes are never guessed. Each status is `available`, `missing`, or `invalid`. Original raw values remain available in `payload`. These fields describe a supplied number, not verified ownership, WhatsApp registration or messaging consent.

The events list remains a metadata list. On sample selection fetch its detail, render Contact beside the original payload, and offer `{{contact.phone}}`, `{{contact.phone_source}}`, `{{contact.phone_status}}` and `{{contact.shipping_phone}}` in the data picker. Do not add `contact` to the original `payload` or put phone numbers in URLs. Actions receive this same contact mapping context. Historical Shopify events also gain the derived contact fields on read without a backfill or schema migration. If Shopify did not send a number, the result stays null; configuring checkout later does not fill old samples.

### 5. Test, then activate

`POST /:flowId/test-runs`:

```json
{
  "event_id": "<captured-event-UUID>",
  "request_id": "<new-client-generated-UUID>"
}
```

HTTP 202 returns the queued run. This explicitly executes configured actions, including writes such as spreadsheet/payment-link creation. Reuse the same `request_id` when retrying the same test request; a new ID requests another execution. Poll `/runs/:runId` to inspect results. A sample must match the currently selected trigger topic.

When the actions are configured, activate with `PATCH /:flowId/status` and `{ "status": "active", "revision": <latest-revision> }`. Subsequent matching provider events automatically queue the saved action chain.

The public endpoint is:

```http
POST /v1/webhook/flows/:flowId/:privateToken
```

No login JWT or user ID belongs in this provider URL. A per-flow token and provider HMAC authenticate the destination and request body. Successful capture returns HTTP 200:

```json
{
  "success": true,
  "data": {
    "accepted": true,
    "duplicate": false,
    "event_id": "<UUID>",
    "run_id": "<UUID-or-null>",
    "mode": "queued"
  }
}
```

Mode is `capture_only` for draft/inactive flows. Delivery IDs are deduplicated per flow; repeated deliveries do not queue another run. Shopify event ID / webhook ID and Razorpay event ID headers are used when present; otherwise the original-body hash is the deduplication identity.

## Supported integration actions

These are `appKey` + `key` values saved in action steps, rather than separate HTTP endpoints for each action. `/apps` supplies their parameter schemas. Flow test runs and signed trigger events execute them.

| appKey | key | Parameters | Result |
| --- | --- | --- | --- |
| `shopify` | `getOrder` | `order_id` | Order summary: ID, name, state and total |
| `shopify` | `listOrders` | Optional `query`, `limit` (1–50), `after` | `nodes` and GraphQL `pageInfo` |
| `shopify` | `getProduct` | `product_id` | Product summary and price range |
| `shopify` | `listProducts` | Optional `query`, `limit` (1–50), `after` | `nodes` and `pageInfo` |
| `google-sheets` | `createSpreadsheet` | `title`; optional `sheet_title` | `spreadsheetId`, `spreadsheetUrl`, sheet metadata |
| `google-sheets` | `getRows` | `spreadsheet_id`, `range` | Google value-range result with `values` |
| `google-sheets` | `appendRows` | `spreadsheet_id`, `range`, `values` | Append/update result |
| `google-sheets` | `updateRows` | `spreadsheet_id`, `range`, `values` | Update result |
| `razorpay` | `createPaymentLink` | `amount_paise`, `description`; optional `customer_name`, `customer_email`, `customer_contact` | Link `id`, `short_url`, status, amount, reference and mode |
| `razorpay` | `getPaymentLink` | `payment_link_id` | Current provider link state |

Shopify resource IDs are numeric strings or matching GraphQL IDs. For a numeric JSON trigger ID, use `"gid://shopify/Order/{{trigger.id}}"` as `order_id`. Order reads need `read_orders`; product reads need `read_products`. Add optional `read_products` to `SHOPIFY_SCOPES`, approve it in the Shopify app configuration, and reconnect the store before using product actions. Existing default scopes are preserved.

Google ranges include a tab, such as `'Order Data'!A1:C100`. Reads/updates must have a bounded ending row, with at most 1,000 rows and 100 columns. Append also accepts an open ending row, such as `Order!A1:C`. Writes accept 1–100 rows, at most 100 primitive cells per row, and always use `RAW` so mapped text is not evaluated as a formula. Action parameters are limited to 128 KB; saved action output is limited to 256 KB.

Razorpay amounts are integer paise, 100–100,000,000, in INR. Link creation disables automatic SMS/email notifications and reminders. Creating a link does not mean a payment succeeded; use a signed payment trigger or fetch its provider state. A deterministic provider reference ties the link to its run/step. Automation Razorpay connections are user-owned and separate from company subscription-checkout gateway configurations.

## Panel contacts and the data picker

The data picker shows fields from a captured trigger or an earlier action. Selecting a field inserts a mapping; it does not create a contact. In the supplied reference screenshot, `cancel_reason` is not a phone and `app_id` is not a customer name. Choose populated customer fields from the actual captured sample.

For paid customers, the intended workflow is **Shopify paid_order → create/update panel contact → optionally appendRows to an existing Google spreadsheet**. `new_order` is appropriate when unpaid orders should also qualify. `createSpreadsheet` creates a new spreadsheet for each run; use `appendRows` to maintain one shared order log.

**Create/update panel contact is a proposed action, not an action currently exposed by `/apps` or implemented in the automation runner.** Do not show it as runnable/configured in the frontend until the backend supports it. Existing contact creation is `POST /v1/admin/contacts`, with fields such as:

```json
{
  "phone_number_id": "<selected-owned-WhatsApp-number-ID>",
  "phone_number": "+919876543210",
  "name": "Customer Name",
  "email": "customer@example.com"
}
```

`phone_number_id` identifies the panel's WhatsApp business number; `phone_number` is the customer's number. The contact belongs to the authenticated account/company and appears in Contacts under that selected business number. A future internal contact action must use the flow's stored owner/company and validate number ownership, plan limits and field values; it must not accept a different account from webhook JSON. The current standalone create API rejects an existing phone in the same account/business-number scope; it is not an upsert. A future action should define duplicate handling explicitly.

Examples for this backend's raw Shopify JSON, only when those fields exist in the captured sample:

| Contact setting | Mapping or selection |
| --- | --- |
| WhatsApp business number | Select an account-owned panel number; do not map the buyer's phone here |
| Customer phone | `{{trigger.customer.phone}}` or a populated `{{trigger.shipping_address.phone}}` |
| Name | `{{trigger.customer.first_name}} {{trigger.customer.last_name}}` or `{{trigger.shipping_address.name}}` |
| Email | `{{trigger.email}}` or `{{trigger.customer.email}}` |
| Assigned to | Select an authorized panel team member; customer email is not an assignee |

Missing phone data must be handled as a clear failure or deliberate skip, rather than replaced with order IDs or null fields. The mapping engine does not evaluate JavaScript fallback expressions. Reference-platform `{{step.ID.body...}}` syntax is not supported here; use `{{trigger...}}` and `{{steps.UUID...}}`. The existing standalone contact-create controller does not accept a top-level assignment/source setting and currently records source as `manually`; adding those automation settings needs backend support. Creating a contact alone does not send a WhatsApp message.

## Trigger catalog

| appKey | key | Provider event |
| --- | --- | --- |
| `shopify` | `new_order` | `orders/create` |
| `shopify` | `updated_order` | `orders/updated` |
| `shopify` | `updated_cart` | `carts/update` |
| `shopify` | `paid_order` | `orders/paid` |
| `shopify` | `new_customer` | `customers/create` |
| `razorpay` | `payment_captured` | `payment.captured` |
| `razorpay` | `payment_link_paid` | `payment_link.paid` |
| `razorpay` | `order_paid` | `order.paid` |

Google Sheets provides actions in this release. Spreadsheet-row polling triggers and arbitrary custom HTTP actions are not included in the catalog.

### Repeated Shopify tests

Select **Cart update** in Shopify for `updated_cart`, **Order update** for `updated_order`, or **Order creation** for `new_order`. These are distinct event types. A signed request for a different topic returns HTTP 200 with `{ "accepted": false, "ignored": true, "reason": "topic_not_configured" }` and is not added to captured samples. HTTP 200 alone does not mean a sample was captured. Shopify's webhook event cannot be edited after creation; create a new webhook when changing its event type.

Each delivery with a new Shopify event ID is captured, even when its sample payload is identical to a previous test. A retry of an already captured event ID returns `{ "accepted": true, "duplicate": true }` without a second sample or another run. Do not remove this deduplication to make the test UI refresh. Poll `/events` while listening and display new event IDs; do not assume only the first delivery can be captured. Older samples remain in history after a trigger change; show samples matching the selected trigger topic in the picker.

When a development tunnel changes, set `AUTOMATION_PUBLIC_BASE_URL` to its current HTTPS origin and restart the API. Re-fetch the flow and copy its full returned `webhookPath`, including flow UUID and token. OAuth callback URLs ending in `/shopify/callback` do not receive flow events.

## Existing Shopify and Google Sheets connection APIs

All paths below are full API paths and require the account-owner login JWT. OAuth start requests use the existing credentialed browser-cookie flow (`credentials: include` for cross-origin fetch); navigate to the returned authorization URL and return through the configured callback. See [Shopify](shopify.md) and [Google Sheets](google-sheets.md) for complete OAuth/UI details.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/admin/shopify/setup` | Check Shopify setup and supported store triggers |
| POST | `/v1/admin/shopify/oauth/start` | Begin connection with `{ "shop": "store.myshopify.com", "name": "Store" }` |
| GET | `/v1/admin/shopify/connections` | List account-owned stores and granted scopes |
| PUT | `/v1/admin/shopify/connections/:id/triggers` | Existing shared-store webhook subscription settings; separate from manual per-flow URLs |
| POST | `/v1/admin/shopify/connections/:id/sync` | Repair existing shared-store subscriptions |
| DELETE | `/v1/admin/shopify/connections/:id` | Disconnect a store |
| GET | `/v1/admin/google-sheets/setup` | Google/Picker setup readiness |
| POST | `/v1/admin/google-sheets/oauth/start` | Start Google OAuth |
| GET | `/v1/admin/google-sheets/connection` | Current owner connection status |
| GET | `/v1/admin/google-sheets/picker-token` | Access token limited to using Google Picker |
| GET | `/v1/admin/google-sheets/spreadsheets` | List spreadsheets accessible through `drive.file` |
| GET | `/v1/admin/google-sheets/spreadsheets/:id/tabs` | Spreadsheet/tab metadata |
| GET | `/v1/admin/google-sheets/spreadsheets/:id/tabs/:sheetId/preview` | Header and sample rows from an existing tab |
| DELETE | `/v1/admin/google-sheets/connection` | Disconnect Google |

Google Sheets creation/row writes use the existing `drive.file` grant. Select pre-existing files through Google Picker; connecting Google does not automatically grant access to every spreadsheet. Use `GET /v1/admin/flows/connections` for the normalized Google connection ID needed by a step.

Create a Razorpay flow connection with `POST /v1/admin/flows/connections`:

```json
{
  "appKey": "razorpay",
  "name": "My Razorpay test account",
  "mode": "test",
  "key_id": "rzp_test_REPLACE",
  "key_secret": "REPLACE_WITH_PRIVATE_SECRET"
}
```

Use `live` and a matching `rzp_live_` key for live operation. The response returns a connection UUID and safe metadata. Saving credentials does not prove they are accepted by Razorpay; provider calls perform the actual authorization check. Secrets are encrypted, excluded from list responses and never placed in steps or webhook URLs.

## Worker, retention and failures

Webhook receipts and queued runs commit atomically in PostgreSQL before HTTP acknowledgement. Worker replicas claim queued runs with `FOR UPDATE SKIP LOCKED`. Each run stores an immutable snapshot of its step configuration and revision. Actions execute in order; one failed action stops subsequent actions.

Run statuses: `queued`, `running`, `succeeded`, `failed`, `requires_review`, `cancelled`. Run detail includes `steps`, each with its step ID, app/action, state, timestamps and output/error when available. The run-level state is authoritative after an interrupted worker.

Interrupted/uncertain writes are not automatically retried: a remote spreadsheet/payment link may already exist even when its response was lost. Runs left running for 15 minutes are marked `requires_review`. Inspect the provider and run outputs before intentionally starting another test. Deactivation/deletion cancels automatic execution before the next action; an already in-flight provider request can finish.

Receipts expire after 30 days. The worker removes expired receipts and dependent run results in bounded batches; expired samples are unavailable for new test runs. Shopify customer erasure tombstones suppress new matching receipts, existing privacy maintenance erases matching automation receipts/results, and shop erasure removes that store's automation history. Outgoing data written into a user's external spreadsheet remains in that external account and must be managed there.

HTTP 400 means invalid/incomplete configuration; 401 means dashboard authentication or provider signature failed; 403 means an inactive/unauthorized account or wrong store; 404 means a resource/connection is unavailable in the account; 409 means a stale revision or editing an active flow; 413 means a size/range limit; 5xx means a setup/provider/database failure. Show the safe response message and preserve the user's editor state on failed saves.

## Deployment and validation

Build with `npm run build`. Apply `20261022000002_automation_flows.ts` and `20261022000003_shopify_client_credentials.ts` using the release's migration tooling, after reviewing pending migrations. The first creates four independent automation tables; the second creates a private encrypted Shopify app credential table. Existing support/chatbot flows are not migrated into them. Deploy the updated API and worker together so both can renew client-credential tokens.

Configure:

```dotenv
AUTOMATION_PUBLIC_BASE_URL=https://YOUR-API-HOST
AUTOMATION_ENCRYPTION_KEY=<32-random-bytes-encoded-as-base64>
```

The public URL is an origin without `/v1`; when omitted it defaults to the existing Shopify callback origin, or Google callback origin. Local HTTP is accepted only for localhost/127.0.0.1 development; providers need a reachable public HTTPS endpoint. If the automation key is omitted, an existing valid 64-hex `PAYMENT_GATEWAY_ENCRYPTION_KEY` is used. Keep the chosen encryption key stable; changing it makes saved destinations, secrets, receipts and results unreadable. API and workers must share the key and database.

The existing `npm run start:worker` includes the automation scheduler. Alternatively run `npm run start:automation-worker` for a separate worker deployment. A worker is required for queued actions and retention maintenance. Starting a worker before the migration only reports missing schema; it does not create tables. No queue/worker rollout or remote provider configuration is performed by editing this API code.

`npm run test:automation` runs mapping/signature/client checks. Full integration requires a fresh disposable loopback PostgreSQL database with `automation_test` in its name:

```sh
AUTOMATION_TEST_DATABASE_URL=postgres://test_user:test_password@127.0.0.1:5432/automation_test npm run test:automation
```

The suite covers real PostgreSQL migrations/native enum users, JWT-authenticated HTTP, actual raw-body middleware, signed Shopify/Razorpay webhooks, ownership, step revisions, capture-only mode, deduplication, competing workers, ordered mappings, uncertain-write recovery, encryption, expiry and fixed provider request shapes. Provider HTTP responses are mocked; testing with each merchant's OAuth/API credentials remains necessary before activation.

Provider contracts: [Shopify order queries](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders), [Google spreadsheet creation](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create), [Google row append](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append), [Razorpay payment links](https://razorpay.com/docs/api/payments/payment-links/create-standard/), [Razorpay webhook verification](https://razorpay.com/docs/webhooks/validate-test/).

## Context to give Claude for the frontend

```text
Integrate the existing Flows page with the separate automation APIs in this document.
Reuse the project's JWT/API client and UI components. Use /v1/admin/flows as the base.
POST {name} to create a draft and navigate to the returned flow UUID. Ownership comes
from login; do not construct account access by adding user_id to a URL.

GET /apps supplies trigger/action options and parameter schemas. GET /connections
supplies scoped connectionId choices. For Shopify show an Add Connection form/table
with Name, Store domain, Client ID and Client Secret (password input). POST
/connections {appKey:"shopify",name,shop,client_id,client_secret}, then select the
returned data.id. Show a saved-secret indicator only; never return, reload or store
the secret in browser storage. Explain that this mode requires an installed app
and store in the same Shopify organization. Preserve platform Shopify OAuth as an
alternative for other merchant stores. Google Sheets uses existing OAuth; Razorpay
uses POST /connections. Keep credentials out of steps.

Render exactly data.steps. For a new/empty flow show an empty canvas and Add Trigger;
never synthesize default trigger/action cards on create, reload or delete. Add a
trigger with POST /:flowId/steps {type:"trigger", ...}; add an action only when the
user clicks Add Action, using type:"action". When a trigger was deleted, keep the
remaining action cards and offer Add Trigger; the server prepends its replacement.
Save a card with PATCH
/:flowId/steps/:stepId, append with POST /:flowId/steps, and save/reorder the full
ordered array with PUT /:flowId/steps. Use the returned revision for stale-save
checks. Let the backend calculate nextStepId and complete/incomplete status.
Add a Delete node item to every node's three-dot menu, including the trigger. Call
DELETE /:flowId/steps/:stepId with the latest revision; render the returned steps.
Clear selection if its node was deleted and flag mappings that reference deleted
outputs. If the flow is active, require deactivation before structural edits.
After trigger deletion show webhook setup as incomplete and require configuration
again. Empty or triggerless drafts can be saved but cannot be published or tested.

For either Shopify connection mode, POST /:flowId/webhook/subscribe after saving
the trigger/connectionId. Do not ask for a separate webhook secret. The backend
uses the selected connection's app secret and registers ONE webhook for the flow's
selected trigger. All action nodes use the received event; adding, editing or
deleting actions must not register more webhooks. GET /:flowId/webhook/status checks
ready state; show safe setup errors and
offer reconnect when authorization is expired/revoked. Call subscribe again after
changing the trigger or public destination. Do not create one subscription on every
listening poll. Remove it through DELETE /:flowId/webhook/subscription before flow
deletion. Explain that actual store events test app-owned webhooks; Shopify's manual
Notifications tests have separate signing credentials.
For Razorpay or explicit Shopify manual testing, display webhookPath and configure
the provider signing secret using POST /:flowId/webhook and explain provider
dashboard webhook registration. Poll
/:flowId/events to show verified samples and retrieve /events/:eventId for mapping.
Draft/inactive flows capture samples without running actions.

Offer {{trigger.field}} and {{steps.STEP_UUID.field}} mappings. For manual tests,
POST /:flowId/test-runs with event_id and one persistent request_id UUID per test.
Label this as executing the configured actions, including external writes. Poll run
detail for step results. Reuse the ID after network failure to avoid duplicate runs.

Activate through PATCH /:flowId/status only when setup is complete. Deactivate before
editing active steps. Display connection, incomplete configuration, 409 stale-save,
provider errors, and requires_review states. Do not automatically retry uncertain
writes. Use the flow list pagination/counts for All/Active/Inactive filters and show
draft badges. Treat all customer/provider strings as text when rendering them.
```
