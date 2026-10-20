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
  "updated": 1
}
```

The API fetches the account details and every page of [Meta's phone-number listing](https://www.postman.com/meta/whatsapp-business-platform/request/e9ady51/get-phone-numbers) before writing to the database. It refreshes the account name, currency, template namespace and metadata, and updates existing phone display numbers, verified names, quality ratings, verification status and metadata. New numbers are added. Existing local UUIDs, local status settings, contacts and other relations are preserved. Repeating the request updates the same rows.

Database changes use a single transaction with bounded phone batches. A fetch failure or conflicting number belonging to another owner, company or WABA aborts the sync. Soft-deleted phone rows belonging to this WABA are restored if Meta still returns them. Numbers absent from Meta are retained; sync does not delete numbers or conversation history. An empty Meta list returns zero synced numbers while still refreshing the account details.

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
      "templates": []
    }
  }
}
```

Only waba_id is needed in the body. No authorization code, OAuth state, redirect URI, idempotency key, polling, or worker is required for a new connection. A missing WABA ID returns HTTP 400 with WABA ID is required. Accounts and phone numbers already owned by another company cannot be transferred.

Configure META_ACCESS_TOKEN with access to the WABA and META_API_VERSION on the API server. The existing saved-credential support remains available for previously connected accounts. Existing job status and retry routes remain available for saved jobs.

Later failures may leave earlier synced rows saved; repeating the request reuses those records. Plan limits still apply to synced numbers, and excess numbers remain inactive. No migration is required.

Regression checks: node --test tests/waba-simple-onboarding.test.cjs tests/waba-sync.test.cjs. Set WABA_ONBOARD_DATABASE_TEST=true to include rollback-only PostgreSQL account ownership/upsert tests.
