# Sync a connected WABA

`POST /v1/admin/waba/:wabaId/sync` refreshes an existing WhatsApp Business Account and its phone numbers from Meta. Use the external numeric Meta WABA ID or the account's local UUID. JWT authentication is required; the owner and company come from the token. Team members operate within their owner's account.

```bash
curl --request POST 'http://localhost:8001/v1/admin/waba/123456789012345/sync' \
  --header 'Authorization: Bearer <JWT>'
```

No request body is needed. The WABA must already belong to this account; unknown, deleted or foreign WABAs return 404. Use `/v1/admin/waba/onboard` to connect a new WABA. New connections use their own encrypted customer authorization. Legacy connections retain the configured server token until reconnected. A new pending connection cannot use the legacy token as a fallback.

The response follows the standard success envelope, with this `data`:

```json
{
  "waba": { "id": "<local UUID>", "waba_id": "123456789012345", "name": "Business account" },
  "phone_numbers": [
    {
      "id": "<local phone UUID>",
      "waba_id": "<local WABA UUID>",
      "phone_number_id": "987654321012345",
      "display_phone_number": "+1 555 1234567",
      "verified_name": "Business",
      "quality_rating": "GREEN",
      "code_verification_status": "VERIFIED"
    }
  ],
  "total_phone_numbers": 1,
  "created": 0,
  "updated": 1
}
```

The API fetches the account details and every page of [Meta's phone-number listing](https://www.postman.com/meta/whatsapp-business-platform/request/e9ady51/get-phone-numbers) before writing to the database. It refreshes the account name, currency, template namespace and metadata, and updates existing phone display numbers, verified names, quality ratings, verification status and metadata. New numbers are added. Existing local UUIDs, local status settings, contacts and other relations are preserved. Repeating the request updates the same rows.

Database changes use a single transaction with bounded phone batches. A fetch failure or conflicting number belonging to another owner, company or WABA aborts the sync. Soft-deleted phone rows belonging to this WABA are restored if Meta still returns them. Numbers absent from Meta are retained; sync does not delete numbers or conversation history. An empty Meta list returns zero synced numbers while still refreshing the account details.

The existing `POST /v1/admin/waba/:wabaId/sync-phone-numbers` route continues to take the local WABA UUID. It now uses the same sync logic and returns all refreshed phone rows, including updated existing numbers, in its existing array response.

## Embedded Signup: frontend integration

All onboarding endpoints require the existing admin JWT. The API derives owner/company from authenticated credentials; request `user_id` or `company_id` fields do not select a tenant. The previous code-less onboarding implementation is replaced: starting a new connection requires a fresh Meta authorization code. Existing accounts can continue using sync.

The login callback's authorization code and the Embedded Signup account-details message arrive separately. Submit the code immediately when the login callback receives it. Do not wait for both IDs, and do not exchange the code in the browser. Send IDs already available at that time, otherwise null:

```http
POST /v1/admin/waba/onboard
Authorization: Bearer <admin JWT>
Content-Type: application/json
Idempotency-Key: <one random UUID per signup attempt>
```

```json
{
  "code": "<fresh Meta authorization code>",
  "state": null,
  "waba_id": null,
  "phone_number_id": null
}
```

`setup_mode` is optional: `auto` is the default; `waba_only` explicitly connects the account without registering a phone and cannot be combined with `phone_number_id`. Empty phone inventory is also supported. Never invent a phone ID for Coexistence or WABA-only signup.

`state: null` remains supported for the current frontend. For an optional server-issued state, call `POST /v1/admin/waba/onboard/state` before opening signup. Pass its `data.state` through the login flow and submit that returned state with the code. It expires after 600 seconds and is bound to the authenticated tenant and a single onboarding. Arbitrary non-null state values are rejected.

The initial response normally uses **HTTP 202**, after the authorization has been exchanged and encrypted storage committed:

```json
{
  "success": true,
  "message": "WhatsApp setup is pending",
  "data": {
    "onboarding_id": "<UUID>",
    "status": "pending",
    "stage": "resolve_assets",
    "waba_id": null,
    "authorized_wabas": [],
    "phone_numbers": [],
    "status_url": "/v1/admin/waba/onboard/<UUID>",
    "poll_after_ms": 2000
  }
}
```

Save `onboarding_id` in frontend state and poll `GET data.status_url` with the JWT every `poll_after_ms` while status is `pending`. Polling returns HTTP 200 for an existing status resource, including statuses that need action. Stop polling on `connected`, `needs_selection`, `action_required`, `exchange_uncertain` or `failed`. Never mark a pending account connected merely because HTTP 202 or `success: true` was returned.

When multiple WABAs were authorized, status becomes `needs_selection` with `data.authorized_wabas: [{"id":"<Meta WABA ID>"}]`. Ask the user to choose; the backend does not pick the first. If a phone choice is needed, use `data.phone_numbers`. Resume using the saved token:

```http
POST /v1/admin/waba/onboard/<onboarding_id>/retry
Authorization: Bearer <admin JWT>
Content-Type: application/json
```

```json
{
  "waba_id": "<selected authorized Meta WABA ID>",
  "phone_number_id": "<selected Meta phone ID, or null>"
}
```

This endpoint also accepts `{}` after a configuration/permission issue has been fixed. It never accepts or re-exchanges a code. The selected phone must belong to the selected WABA. An unresolved rejected selection can be corrected before the account is claimed; an already resolved account cannot be changed to a different WABA. If account details arrive late, pass them to this retry endpoint while the saved attempt is still pending. A completed selection cannot be replaced by a late message.

On completion, both the status endpoint and a duplicate onboarding request return:

```json
{
  "success": true,
  "message": "WhatsApp account connected",
  "data": {
    "id": "<internal WABA UUID>",
    "waba_id": "<Meta WABA ID>",
    "status": "connected",
    "phone_numbers": []
  }
}
```

The phone array contains saved inventory when available. WABA-only signup may legitimately return an empty array. Refresh `GET /v1/admin/waba`, `GET /v1/admin/waba/<internal WABA UUID>/phone-numbers` and/or `GET /v1/admin/waba/phone-numbers` after completion. Inspect `connection_status` separately from legacy `status` and subscription capacity `active`. Over-limit phone numbers remain saved with `active: false`; connecting does not bypass subscription limits.

Failures use a safe, stable error envelope:

```json
{
  "success": false,
  "message": "Meta could not exchange this authorization code. Complete Embedded Signup again and submit the new code immediately.",
  "error": { "code": "META_CODE_INVALID", "retryable": false }
}
```

Failed authorization-code exchanges also write a server-side `console.error` entry prefixed `[WABA signup] Meta code exchange failed`. Inspect `http_status`, `meta_error_code`, `meta_error_subcode`, `meta_error_type`, the redacted `meta_message`, `fbtrace_id`, and `network_code`. A timeout/DNS failure may have no Meta message or trace ID. A successful HTTP response without a usable token is logged as an unconfirmed exchange. Raw Axios objects, request URLs/headers, authorization codes, tokens, and app secrets are not logged. These diagnostics do not alter client responses or retry the consumed code; start a fresh Embedded Signup when the code exchange failed or is unconfirmed.

Pending/action status resources may include `data.error` with `code`, `message`, and `retryable`. Terminal POST responses can also include the onboarding ID and safe status data. Display the explanation, not a generic connected banner.

| Error | Frontend action |
| --- | --- |
| `META_CODE_INVALID`, `CODE_EXCHANGE_UNCONFIRMED`, `SIGNUP_TOKEN_INVALID` | Open a fresh signup. Never loop over the old code. |
| `WABA_AUTHORIZATION_SAVE_UNCONFIRMED` | Check the saved status if known; if authorization was not saved, start fresh signup. |
| `SIGNUP_SELECTION_REQUIRED`, `WABA_PHONE_SELECTION_REQUIRED` | Show the available choices and POST the selection to retry. |
| `WABA_NOT_AUTHORIZED`, `SIGNUP_PHONE_NOT_IN_WABA` | Correct the unresolved selection or reconnect with the right asset grants. |
| `META_PERMISSION_REQUIRED`, `WABA_ASSET_DISCOVERY_REQUIRED` | Fix app access/asset assignment; reconnect if the token lacks the required grant. |
| `WABA_WEBHOOK_CONFIGURATION_REQUIRED`, `WABA_CONFIGURATION_REQUIRED` | Platform operator fixes configuration, then retry the saved onboarding. |
| `WABA_PHONE_VERIFICATION_REQUIRED`, `WABA_PHONE_MODE_UNCONFIRMED`, `WABA_META_SETUP_REJECTED` | Complete/correct setup in WhatsApp Manager, then retry. |
| `WABA_ALREADY_CONNECTED_ELSEWHERE`, `WABA_SIGNUP_SUPERSEDED` | Show the ownership/newer-signup explanation; do not repeatedly reconnect. |
| `META_TEMPORARILY_UNAVAILABLE`, `WABA_REGISTRATION_PENDING`, `WABA_COEXISTENCE_PENDING` | Keep polling pending status; the worker rechecks with bounded backoff. |
| `SIGNUP_RETRY_EXHAUSTED` | Stop automatic polling, show the setup issue and offer saved-onboarding retry. |

Do not log/store the authorization code in analytics, browser storage, URLs or error reports. Retrying the same code/key returns the same stored attempt and never repeats the exchange. Use a new idempotency key for a new signup code. If the first request's response is lost, retry that same request with the same key to recover its status; the server will not replay a known exchange. A timeout or process crash after Meta consumes a code but before token storage cannot be made atomic across Meta and PostgreSQL: that attempt requires fresh signup rather than a speculative exchange retry.

## Backend recovery and setup behavior

Onboarding jobs, encrypted tokens, progress, leases, retry times and verified account events live in PostgreSQL. The existing worker process polls due jobs every five seconds; restarting a worker preserves jobs and expired leases can be reclaimed. No authorization code is saved, queued or logged: only its SHA-256 fingerprint is retained for deduplication. Tokens and generated registration PINs use AES-256-GCM encryption bound to company, owner and onboarding. All API/worker replicas must use the same stable encryption key.

Run the existing `npm run worker` in development or `npm run start:worker` after building in production, alongside the API. Transient setup failures retry up to six worker attempts with bounded exponential backoff; an interrupted exchange is never retried by the worker. Failures remain inspectable/actionable through the status endpoint. A verified, deduplicated `account_update` can wake an associated unfinished attempt and trigger a fresh Meta read. Webhooks never create a tenant association or supply an access token. Signature validation is added specifically for account-update deliveries; existing message-only webhook behavior is preserved.

Discovery uses the exchanged token's granular WABA grants, or assets assigned to that token's system user if granular target IDs are absent. It never enumerates the provider's global client inventory. Both supplied and discovered accounts are checked with that token. Multi-account authorization requires selection. Account and phone ownership conflicts abort setup instead of moving records between companies. Reconnecting an existing working account preserves its current usable credentials until the replacement setup succeeds.

Inventory uses the same `WabaService.syncWaba` transaction as the public sync endpoint. Account metadata, phone names/numbers, verification/quality fields, Meta registration status/platform/Coexistence metadata and synchronization timestamps are stored. Standard verified Cloud API numbers may be registered using a securely persisted generated six-digit PIN. An uncertain registration dispatch is rechecked, not blindly sent again. Existing two-step-verification/PIN or migration restrictions must be corrected in WhatsApp Manager if Meta rejects registration. Coexistence is detected from Meta's `is_on_biz_app`, not a browser hint; it is never sent through standard registration, migration or deregistration. Its selected number must report `CONNECTED` on `CLOUD_API` before completion. This integration synchronizes account/phone inventory; it does not request or import optional WhatsApp Business chat-history/contact synchronization.

The app callback configuration and WABA subscription are read back and verified. Only then, with the required phone setup confirmed and inventory refreshed, are the new credential and connected account state committed together. Pending new phones cannot be used for sending; existing subscription quota rules continue to apply.

## Deployment and Meta dashboard configuration

Apply `20261019000006_waba_embedded_signup.ts` before deploying this API/worker. It adds onboarding/state/credential/event tables and connection/timestamp columns, with legacy defaults that preserve existing accounts. It was applied to the configured development database during implementation. Do not roll it back after connecting customer accounts without first reconciling their credentials.

Configure these server environment variables; do not send them from the frontend:

| Variable | Requirement |
| --- | --- |
| `META_APP_ID`, `META_APP_SECRET` | The same Meta app used by Embedded Signup; existing `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` are fallbacks. |
| `META_API_VERSION` | An active Graph API version supported by your app and the fields/flows above. The old example value is not a recommendation for a current version. |
| `WABA_TOKEN_ENCRYPTION_KEY` | Stable base64-encoded 32-byte key on API and all workers; `FACEBOOK_TOKEN_ENCRYPTION_KEY` is a fallback. Keep it in the deployment secret manager. |
| `WABA_WEBHOOK_CALLBACK_URL` | Exact public HTTPS callback, normally `https://<api-host>/v1/webhooks/meta`. |
| `META_WEBHOOK_VERIFY_TOKEN` | The existing callback verification token, also configured in Meta. |
| `WABA_OAUTH_REDIRECT_URI` | Optional; set only if the login flow uses it, and match the authorized redirect URI exactly. |
| `META_BUSINESS_ID` | Optional portfolio context for assigned-system-user asset enumeration when granular grants are absent. |

In Meta App Dashboard / WhatsApp Manager:

1. Use the Facebook Login for Business / Embedded Signup configuration belonging to this app. Configure the dashboard's allowed domains, OAuth redirect URI if used, signup configuration ID, and the intended standard, WABA-only or Coexistence flow in the frontend. A business-login configuration ID belongs in the frontend SDK configuration; the exchange uses the matching server app credentials.
2. Request `whatsapp_business_management` for asset management and `whatsapp_business_messaging` for phone registration/messaging. Obtain the access level, app review, business verification and Tech Provider enrollment required for your app to onboard external customers, and use the appropriate live app mode. Grant the resulting system user access to the customer's WABA. `business_management` is needed only when your chosen portfolio/system-user discovery operations require it; it is not substituted for WhatsApp grants. See [Meta's Cloud API collection and permission guidance](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api).
3. Verify the WhatsApp Business Account webhook object's callback using `META_WEBHOOK_VERIFY_TOKEN`. Subscribe `messages` and `account_update`. For Coexistence also configure `smb_app_state_sync`, `smb_message_echoes` and `history`. The worker verifies the app-level subscription matches the configured callback and then confirms the app is subscribed to the selected WABA; it does not rewrite the app's shared dashboard callback. Deliver the original signed JSON bytes and `X-Hub-Signature-256` to the API without proxy rewriting.
4. Complete phone verification and any required account/payment/business checks in WhatsApp Manager. Standard Cloud registration uses [Meta's phone registration operation](https://www.postman.com/meta/whatsapp-business-platform/request/mk4p87j/register-phone-number). Complete Coexistence in the appropriate signup flow and retain the Business app connection; this backend does not force a migration when Meta has not confirmed the expected mode/status.

Automated transport/worker/database tests use fake Meta responses and rollback-only database fixtures. A live Embedded Signup test still requires a fresh customer authorization code and correctly configured Meta app; it was not performed with customer credentials during implementation.
