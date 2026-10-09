# Sync a connected WABA

`POST /v1/admin/waba/:wabaId/sync` refreshes an existing WhatsApp Business Account and its phone numbers from Meta. Use the external numeric Meta WABA ID or the account's local UUID. JWT authentication is required; the owner and company come from the token. Team members operate within their owner's account.

```bash
curl --request POST 'http://localhost:8001/v1/admin/waba/123456789012345/sync' \
  --header 'Authorization: Bearer <JWT>'
```

No request body is needed. The WABA must already be connected to this account; unknown, deleted or foreign WABAs return 404. Use the existing `/v1/admin/waba/onboard` endpoint to connect a new WABA. This endpoint uses the server's configured Meta access token.

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
