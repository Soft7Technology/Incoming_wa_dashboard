# Sync a connected WABA

`POST /v1/admin/waba/:wabaId/sync` refreshes an existing WhatsApp Business Account and its phone numbers from Meta. Use the external numeric Meta WABA ID or the account's local UUID. JWT authentication is required; the owner and company come from the token. Team members operate within their owner's account.

```bash
curl --request POST 'http://localhost:8001/v1/admin/waba/123456789012345/sync' \
  --header 'Authorization: Bearer <JWT>'
```

No request body is needed. The WABA must already belong to this account; unknown, deleted or foreign WABAs return 404. Use `/v1/admin/waba/onboard` to connect a new WABA. New ID-only connections use the configured Meta server token. Existing connected accounts retain their saved credentials. Previous pending jobs can finish through their legacy setup path.

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
  "updated": 1,
  "reactivated_count": 0,
  "skipped_count": 0,
  "skipped_phone_numbers": [],
  "remaining_slots": 0
}
```

The API fetches the account details and every page of [Meta's phone-number listing](https://www.postman.com/meta/whatsapp-business-platform/request/e9ady51/get-phone-numbers) before writing to the database. It refreshes the account name, currency, template namespace and metadata, and updates existing phone display numbers, verified names, quality ratings, verification status and metadata. New numbers are added. Existing local UUIDs, local status settings, contacts and other relations are preserved. Repeating the request updates the same rows.

Database changes use a single transaction with bounded phone batches. A fetch failure or conflicting number belonging to another owner, company or WABA aborts the sync. New numbers and soft-deleted restorations require a remaining `WabaNumber` slot. The effective allowance is the active user plan's base `limit` plus `addon_limit`, less the live count of active, non-deleted numbers across the owner's WABAs. The owner/plan lock prevents concurrent syncs from claiming the same last slot. Numeric integer strings in historical add-on snapshots are read as numbers; malformed values do not grant capacity.

Only new numbers fitting the remaining slots are saved. Other fetched numbers appear in `skipped_phone_numbers` with `phone_number_id` and reason `PLAN_LIMIT_EXCEEDED` (or `PLAN_UNAVAILABLE` without usable entitlement); no inactive overflow row is inserted. `total_phone_numbers` counts fetched Meta numbers, `created` and `updated` count saved rows, and `skipped_count` counts unsaved numbers. `remaining_slots` is the capacity after this sync, or null for unlimited. With one remaining slot and two new Meta numbers, one is saved and the second is skipped. A zero-slot sync can still refresh existing rows. Increasing capacity and syncing again imports previously skipped numbers.

After a plan upgrade or add-on purchase, sync reactivates saved, non-deleted numbers returned by Meta with `active: false` and `inactive_reason: PLAN_LIMIT_EXCEEDED` or `PLAN_UNAVAILABLE`, up to the remaining allowance. These numbers receive slots before new inventory, become `active: true`, and have `inactive_reason` cleared. `reactivated_count` counts these transitions; reactivated rows also count as `updated`. Repeating sync does not consume extra slots. For example, a base allowance of one plus two purchased add-on slots allows three active numbers across the owner's WABAs.

Manually disabled numbers and inactive rows with an unknown reason remain inactive. Existing numbers absent from Meta are retained without activation; sync does not delete numbers or conversation history. Soft-deleted rows remain deleted if there is no slot to restore them. An empty Meta list returns zero synced numbers while still refreshing the account details. Direct single-number creation returns 403 when no slot is available.

The existing `POST /v1/admin/waba/:wabaId/sync-phone-numbers` route continues to take the local WABA UUID. It now uses the same sync logic and returns all refreshed phone rows, including updated existing numbers, in its existing array response.

## Connect using a WABA ID

Send the Meta WABA ID to the existing onboarding route. Owner and company come from the authenticated admin JWT.

```http
POST /v1/admin/waba/onboard
Authorization: Bearer <admin JWT>
Content-Type: application/json
```

```json
{ "waba_id": "123456789012345" }
```

The request saves or updates the owned WABA, syncs its phone numbers, subscribes to Meta webhooks, and syncs templates. It returns HTTP 201 when those steps finish, using the previous response structure:

```json
{
  "success": true,
  "message": "WABA account setup successfully",
  "data": {
    "clientAccountStatusMessage": "Client WABA account setup successfully",
    "data": {
      "clientWabaAccount": { "id": "<local UUID>", "waba_id": "123456789012345" },
      "phoneNumbers": [],
      "webhook": { "success": true },
      "templates": [],
      "phone_number_sync": {
        "total_phone_numbers": 2,
        "created": 0,
        "updated": 0,
        "skipped_count": 2,
        "skipped_phone_numbers": [
          { "phone_number_id": "<first-Meta-phone-ID>", "reason": "PLAN_LIMIT_EXCEEDED" },
          { "phone_number_id": "<second-Meta-phone-ID>", "reason": "PLAN_LIMIT_EXCEEDED" }
        ],
        "remaining_slots": 0
      }
    }
  }
}
```

Only waba_id is needed in the body. No authorization code, OAuth state, redirect URI, idempotency key, polling, or worker is required for a new connection. A missing WABA ID returns HTTP 400 with WABA ID is required. Accounts and phone numbers already owned by another company cannot be transferred.

Configure META_ACCESS_TOKEN with access to the WABA and META_API_VERSION on the API server. The existing saved-credential support remains available for previously connected accounts. Existing job status and retry routes remain available for saved jobs.

Later failures may leave earlier synced rows saved; repeating the request reuses those records. Plan limits apply before new number insertion; excess fetched numbers are skipped. The existing `data.data.phoneNumbers` array contains saved numbers, and `data.data.phone_number_sync` describes quota skips. The frontend should display those skipped IDs and offer upgrading or freeing a slot; a successful WABA connection does not imply every Meta number was saved. No migration is required.

Regression checks: node --test tests/waba-simple-onboarding.test.cjs tests/waba-sync.test.cjs. Set WABA_ONBOARD_DATABASE_TEST=true to include rollback-only PostgreSQL account ownership/upsert tests.

Quota checks: `node --test tests/plan-usage.test.cjs tests/dynamic-plan-addons.test.cjs`. The concurrent allocation regression is `node --test tests/waba-capacity-database.test.cjs`, with `WABA_CAPACITY_TEST_DATABASE_URL` pointing to a fresh disposable loopback PostgreSQL database whose name contains `waba_capacity_test`. It creates synthetic test tables and checks the real owner locks, add-on allowance, skip reporting, direct creation, downgrade handling and tenant conflicts. Never point it at the application database.
