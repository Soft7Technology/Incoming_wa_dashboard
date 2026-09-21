# User API keys

Run `npm run migrate:latest` before restarting the API. The new migration
`20260921000002_rename_client_api_keys_to_user_api_keys.ts` renames the existing
table to `user_api_keys` while preserving keys. Keep the original creation migration
in migration history. No database migration has been executed by this change.

The name field is removed by migration `20260921000003_remove_user_api_key_name.ts`.
Creation requires no body fields; user and company IDs come from the JWT.

## Issue and revoke

An active user authenticates with their existing JWT:

```http
POST /v1/admin/api-keys
Authorization: Bearer <user JWT>
Content-Type: application/json

{}
```

Copy `data.apiKey` from the response. Its SHA-256 hash is used for authentication; an encrypted copy is stored for dashboard display. `GET /v1/admin/api-keys` lists metadata and the decrypted `apiKey`. `DELETE /v1/admin/api-keys/:id`
revokes a key immediately. Both require the user's JWT and are user/company scoped.
Team members can create keys for their own user ID; the inviter's ID is not used. Keys have no automatic expiration;
revoke and issue another to rotate.

## Client requests

```http
GET /v1/api/waba/phone-numbers
x-api-key: s7_<secret>
```

The key supplies the user's user ID, company ID, and current database role. No
company-key header, JWT, or user/company body fields are needed. These keys grant
the user's access to the API-consumer routes; they are not limited to one phone
number or specific actions. Use the same user key for your integrations and use HTTPS in
production. Revoked keys and inactive/deleted users or companies are rejected.

API authentication accepts only issued user API keys. Legacy company keys are no
longer accepted, and `x-company-key` is ignored. Use the full `data.apiKey` returned
at creation (starting with `s7_`), never the stored hash or prefix.

Import `postman/API-Key-Management.postman_collection.json` for user administration.
Give clients `postman/Client-Single-Key.postman_collection.json` and set `base_url`,
`api_key`, `phone_number_id`, and `recipient`. Template requests also require the
actual template name/language/components. Send requests make real API calls.
Collections contain no credentials. Transmit the newly issued secret separately.

## One active key per user

Run all pending migrations before restarting the backend. Migration
`20260921000004_one_active_api_key_per_user.ts` retains the newest active key
per user and revokes older active keys. It adds a unique index enforcing this rule.
POST `/v1/admin/api-keys` atomically replaces the previous key; save the returned
secret and update integrations after rotation. GET returns zero or one active key
in the existing array response. Revoked records remain for history.

## Dashboard key display

Before creating new keys, set USER_API_KEY_ENCRYPTION_KEY to a persistent random
32-byte secret encoded as 64 hex characters. Generate one locally with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep this secret in server configuration and retain it across deployments.
Run `npm run migrate:latest`, then restart. New keys store AES-256-GCM ciphertext
in `user_api_keys.api_key_encrypted`. JWT-authenticated GET `/v1/admin/api-keys`
returns `data[0].apiKey` for dashboard display with Cache-Control: no-store.
Old hash-only keys return apiKey: null; rotate once with POST to enable display.
Changing the encryption secret makes previously encrypted keys unreadable.
