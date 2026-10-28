# Google People / Google Contacts

Creates and edits contacts in the Google account authorized by the signed-in dashboard
owner. It also lists contacts and reads an individual contact for editing. Supported
fields: `names`, `emailAddresses` and `phoneNumbers`. This is separate from local
WhatsApp contacts and the Google Sheets integration; no WhatsApp messages are sent.

## Setup

1. Enable **People API** in your Google Cloud project.
2. Configure the Google OAuth consent screen and a Web application OAuth client. Add
   the exact callback shown in the browser app to Authorized redirect URIs:
   `https://YOUR-HOST/v1/integrations/google-people/callback`.
3. In development, add the Google account as an OAuth test user if the app is in Testing.
   Production usage may require Google brand/scope verification for the `contacts`
   permission. OAuth app credentials alone do not grant access to contacts.
4. Open `/v1/integrations/google-people/app` on the public API host. Sign in with the
   dashboard owner account, configure credentials if needed, then click **Connect
   Google Contacts** and approve Google's Contacts permission.
5. Load/read contacts, or use the contact JSON editor to create and edit them. The
   editor preserves every returned email/phone entry when loading a contact for editing.

The callback defaults to the origin of `GOOGLE_REDIRECT_URI` with the People callback
path above. Set `GOOGLE_PEOPLE_REDIRECT_URI` explicitly to override it. No change to the
Sheets callback is needed. A local HTTP callback is supported for localhost only.

## White-label credentials

An account owner can save their own Google OAuth Client ID and Client Secret with
`PUT /v1/admin/google-people/oauth-app`. These settings are scoped by both `company_id`
and `owner_id`, encrypted and inaccessible to other accounts. They are account-specific;
this is not a company-wide credential sharing/admin delegation mechanism.

Each user's authorization and token refresh uses the credentials saved for that
connection. Updating/removing the OAuth app settings cancels pending authorization and
disconnects Google Contacts for that account, so reconnect with the new app. Client
secrets never appear in settings responses or authorization URLs.

If account credentials are absent, the backend can use `GOOGLE_PEOPLE_CLIENT_ID` and
`GOOGLE_PEOPLE_CLIENT_SECRET`, or the existing `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` as a fallback. Set `GOOGLE_PEOPLE_REQUIRE_CUSTOM_CLIENT=true`
to require account-owned credentials. This setting does not affect Google Sheets.

`GOOGLE_PEOPLE_TOKEN_ENCRYPTION_KEY` is an optional separate stable 32-byte base64 key.
Otherwise the existing `GOOGLE_TOKEN_ENCRYPTION_KEY` is used with an independent People
encryption context. Do not rotate an existing key without migrating stored records.

For a separate frontend, configure `GOOGLE_PEOPLE_FRONTEND_URL` (or the existing
`GOOGLE_FRONTEND_URL`) as the allowed credentialed origin. Authorization must start in
the same browser that will receive the callback: OAuth uses a scoped HttpOnly cookie,
PKCE and expiring single-use state. Postman's cookie jar is not the browser's cookie jar;
use the browser app for interactive authorization before testing authenticated APIs.

## Routes

All admin endpoints require `Authorization: Bearer OWNER_JWT`, the `user` role and an
active account/company. A team member cannot manage the owner's Google Contacts.

| Method | Route under `/v1/admin/google-people` | Purpose |
| --- | --- | --- |
| GET | `/setup` | Callback, scope and safe app-configuration status |
| PUT | `/oauth-app` | Save `{ "client_id": "...", "client_secret": "..." }` |
| DELETE | `/oauth-app` | Remove account credentials and local connection |
| POST | `/oauth/start` | Start browser-bound Contacts authorization |
| GET | `/connection` | Safe connection status; no tokens |
| DELETE | `/connection` | Remove local People tokens and pending sessions |
| GET | `/contacts?page_size=50&page_token=...` | Paginated contact list; page size 1–100 |
| GET | `/contacts/:personId` | Read a contact, including source version metadata |
| POST | `/contacts` | Create a contact |
| PATCH | `/contacts/:personId` | Edit only the supplied contact fields |

Use the ID from Google's `resourceName`, such as `c123` from `people/c123`. An encoded
`people/c123` is also accepted as the route parameter. Arbitrary URLs, paths and
`people/me` are rejected. Only CONTACT-source records can be edited; account/profile
records are not writable contacts.

Create example:

```json
{
  "names": [{ "givenName": "Asha", "familyName": "Test" }],
  "emailAddresses": [{ "value": "asha@example.com", "type": "work" }],
  "phoneNumbers": [{ "value": "+14155552671", "type": "mobile" }]
}
```

Read the contact first. From `metadata.sources`, take the `etag` of the source whose
`type` is `CONTACT`, then update:

```json
{
  "source_etag": "CONTACT_SOURCE_ETAG_FROM_GET",
  "phoneNumbers": [{ "value": "+14155552672", "type": "mobile" }]
}
```

The backend reads the current contact, checks this version, and supplies the required
contact source metadata and exact `updatePersonFields` mask to Google. A changed contact
returns **409**: read it again and reapply the intended edits. Do not substitute the
top-level Person etag for the CONTACT source etag.

Each supplied field array replaces that field. Omitted fields remain unchanged. Use
`"emailAddresses": []` to remove all email addresses deliberately. Preserve every entry
you want to keep. Names are limited to one entry; email/phone lists to 20 entries each.
Addresses, organizations, photos, groups and contact deletion are outside this version.

## Storage and write behavior

People has its own encrypted credentials, sessions and connections. Only
`https://www.googleapis.com/auth/contacts` is requested; Sheets' `drive.file` tokens and
Picker endpoints remain separate. Contact bodies are passed to Google rather than
stored as a second local address book. Access tokens and raw Google/Axios failures are
not returned to the browser or logged.

Requests for one saved connection are serialized with PostgreSQL transaction advisory
locks, including refresh, OAuth changes and disconnect. Automatic provider-write retries
are disabled. If a write times out, Google may already have applied it: inspect Google
Contacts before repeating a create. Retrying a create manually can create a duplicate;
this version has no durable per-request idempotency ledger.

Local disconnect removes the application's People credentials; it does not delete any
Google contacts. It does not revoke a potentially shared Google app grant and thereby
interrupt Sheets. Users can separately revoke the app from their Google Account settings.

## Deployment and validation

Apply `20261017000004_google_people.ts`, build and restart the API using the repository's
normal deployment process. The migration was applied to the configured development
database. No real Google contact was created or edited during implementation.

```text
npm run test:google-people
node scripts/google-people-db-check.cjs
npm run build
```

The tests use isolated Google responses. The PostgreSQL fixture creates a temporary
schema inside a rolled-back transaction and does not contact Google. Live Google
authorization and People API enablement still require the project owner's setup.

References: [Contacts guide](https://developers.google.com/people/v1/contacts),
[createContact](https://developers.google.com/people/api/rest/v1/people/createContact),
[updateContact](https://developers.google.com/people/api/rest/v1/people/updateContact),
[Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
