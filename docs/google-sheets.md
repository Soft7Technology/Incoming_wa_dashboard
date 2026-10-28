# Google Sheets campaigns API

The integration reads user-selected Google spreadsheets, saves an immutable preview,
imports its valid rows through the existing contact-import worker, and creates campaigns
through the existing campaign service. No message is sent during connection, preview or
import. Campaigns are drafts unless `send_immediately` or `scheduled_at` is provided.

## Setup

1. In Google Cloud, enable the Google Sheets API, Google Drive API and Google Picker API.
2. Configure the OAuth consent screen, add test users, and create a **Web application** client.
3. Register `https://ea13-2401-4900-8fea-1cc3-f8ac-28c8-9ea8-a7ab.ngrok-free.app/v1/integrations/google/callback` as an authorized redirect URI.
4. Set the following on the API and worker servers. Generate an independent encryption key,
   keep it stable across restarts/replicas, and keep secrets outside source control:

   ```env
   GOOGLE_CLIENT_ID=your-web-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REDIRECT_URI=https://ea13-2401-4900-8fea-1cc3-f8ac-28c8-9ea8-a7ab.ngrok-free.app/v1/integrations/google/callback
   GOOGLE_FRONTEND_URL=https://app.soft7.in
   GOOGLE_TOKEN_ENCRYPTION_KEY=base64-encoded-32-random-bytes
   ```

   Generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

5. Run `npm run migrate:latest`, `npm run build`, then restart the API and worker.
   The API and worker must share Redis, PostgreSQL and the same persistent `uploads` directory.
   Private snapshot files are under `uploads/.google-sheets`; dot directories are excluded
   from the public uploads route. Do not expose this directory in IIS/static hosting.
6. Register your actual frontend origin for Google Picker and restrict its browser API key.
   Publish/verify the OAuth application as required before customer rollout.

The implementation uses Google HTTPS REST endpoints through the existing Axios dependency.
It requests only `https://www.googleapis.com/auth/drive.file`, not access to all Drive files.

## Authentication and endpoints

All paths below are relative to **`/v1/admin/google-sheets`** and require
`Authorization: Bearer <dashboard JWT>`. This first version is restricted to the account
owner (`user` role); team members cannot use the owner's Google credentials.

| Method | Path                                      | Purpose                                                       |
| ------ | ----------------------------------------- | ------------------------------------------------------------- |
| GET    | `/setup`                                  | Configuration readiness and import limits                     |
| POST   | `/oauth/start`                            | Start Google OAuth; sets browser-binding cookie               |
| GET    | `/connection`                             | Connection status, without credentials                        |
| DELETE | `/connection`                             | Revoke Google grant and remove local credentials              |
| GET    | `/picker-token`                           | Short-lived Google access token for Google Picker only        |
| GET    | `/spreadsheets?page_token=...`            | List spreadsheets already authorized for this application     |
| GET    | `/spreadsheets/:id/tabs`                  | Spreadsheet title and numeric tab IDs                         |
| GET    | `/spreadsheets/:id/tabs/:sheetId/preview` | Headers and up to 20 raw sample rows for column mapping       |
| POST   | `/preview`                                | Validate rows and save a recipient snapshot (201)             |
| GET    | `/snapshots`                              | Latest 50 preview/import records                              |
| POST   | `/snapshots/:id/import`                   | Queue the saved snapshot as a contact import (202)            |
| GET    | `/snapshots/:id/import`                   | Import progress, errors and resulting contact list            |
| POST   | `/campaigns`                              | Create one campaign from a completed import (201; replay 200) |
| POST   | `/campaigns/bulk`                         | Create up to 10 campaign requests, with per-item results      |

The Google callback is public at **`GET /v1/integrations/google/callback`**. It validates
hashed, expiring, one-use state, a browser cookie and PKCE before saving encrypted tokens.
Do not call the callback manually or attach a JWT to it. It returns a small JSON result;
the frontend should then query `/connection` to refresh its UI.

### Browser connection and selection

Call `/oauth/start` from the dashboard with `credentials: 'include'`, then navigate the
same browser to `data.authorization_url`. After consent, the callback must receive the
cookie created by `/oauth/start`. For cross-origin requests, `GOOGLE_FRONTEND_URL` must
match the dashboard origin. HTTPS cookies use SameSite=None; localhost HTTP uses Lax.
Browsers blocking third-party cookies may block a connection initiated across unrelated
sites; use dashboard/API hostnames under the same site or a same-site reverse proxy.

The OAuth code, state, and tokens must not enter IIS/CDN/APM query-string logs. The
application skips Morgan logging on the public callback route. In IIS logging, exclude
URI Query for that site or configure equivalent route-specific redaction upstream.

Get `/picker-token`, pass its access token to Google Picker's `setOAuthToken`, set the
Google Cloud project number as Picker's app ID, restrict selection to spreadsheets and
capture the selected document ID. Keep this short-lived token in browser memory only.
Never expose the refresh token or client secret. The browser API key is separate from
the OAuth client secret.

`/spreadsheets` lists only files already selected/opened through the app. It can be empty
until the user chooses a file in Picker. Pasting an arbitrary private spreadsheet ID does
not grant access. Use the ID, not its full URL, in API requests.

## 1. Preview and save recipients

The first row must have unique, non-empty headers. Use plain text for phone numbers.
`phone_number_id` is the **internal UUID** returned by the sender API, not Meta's numeric ID.

```http
POST /v1/admin/google-sheets/preview
Authorization: Bearer <JWT>
Content-Type: application/json
```

```json
{
  "spreadsheet_id": "YOUR_GOOGLE_SPREADSHEET_ID",
  "sheet_id": 0,
  "phone_number_id": "SENDER_INTERNAL_UUID",
  "country_code": "91",
  "mapping": {
    "phone": "Mobile",
    "name": "Guest Name",
    "email": "Email"
  }
}
```

Use `mapping.country_code` for a per-row country column, or `country_code` as the fallback
for national numbers. Explicit international numbers are supported. Extra columns become
contact attributes. Reserved columns `phone_number`, `name`, `email`, `country_code` must
be mapped or renamed. For example, map `"country_code": "country_code"` if present.

The response contains `data.snapshot_id`, `summary` (valid, invalid, duplicate counts,
up to 100 row errors), normalized `headers`, and up to 20 `sample_rows`. Invalid rows and
duplicates are excluded from the saved import. A preview expires after 24 hours if it has
not been imported. Limits are 10,000 rows, 100 tab columns and a 4 MB saved snapshot.
Date cells are fetched as formatted strings; full phone identities are normalized before
writing the XLSX snapshot. Changes to Google Sheets after preview do not change this import.

## 2. Import the saved snapshot

```http
POST /v1/admin/google-sheets/snapshots/SNAPSHOT_UUID/import
```

```json
{ "list_name": "October event guests" }
```

The response includes `import_job_id` and `status_url`. Repeating this call for a snapshot
returns the same import job. A changed list name does not create another import.
Poll `status_url` until `status` is `completed`; review failed rows before continuing.
The existing contact plan limits, phone normalization, contact updates and import worker apply.

## 3. Create a campaign (one campaign, many sheet recipients)

```http
POST /v1/admin/google-sheets/campaigns
```

```json
{
  "request_id": "october-guests-001",
  "snapshot_id": "SNAPSHOT_UUID",
  "campaign": {
    "name": "October invitations",
    "template_id": "APPROVED_TEMPLATE_UUID",
    "parameter_mapping": {
      "1": { "field": "name" },
      "2": { "field": "attributes.Event", "fallbackValue": "our event" }
    }
  }
}
```

The sender and recipients come from the import. The template must belong to the sender's
WABA and be approved. Existing plan limits and opt-out filtering are preserved. Each
campaign's resolved template parameters are saved by the normal campaign service.

This creates a **draft**. To queue immediately, add `"send_immediately": true` inside
`campaign`. To schedule, add a future ISO `scheduled_at` with an explicit time zone.
Alternatively use existing `POST /v1/admin/campaigns/:id/start`, `/:id/test`, `/:id/pause`,
`/:id/resume`, and `GET /:id/progress` or `/:id/stats`.

Reuse the same `request_id` and identical payload when retrying a request. A receipt commits
in the same database transaction as the campaign, preventing duplicate creation/sending
from repeated integration requests. Reusing an ID with different settings returns 409.
If the import completed with failed rows, review its report and explicitly add
`"accept_partial_import": true` to use only successfully imported recipients.

## 4. Create multiple campaigns

```http
POST /v1/admin/google-sheets/campaigns/bulk
```

```json
{
  "campaigns": [
    {
      "request_id": "event-a-001",
      "snapshot_id": "FIRST_SNAPSHOT_UUID",
      "campaign": { "name": "Event A", "template_id": "TEMPLATE_UUID" }
    },
    {
      "request_id": "event-b-001",
      "snapshot_id": "SECOND_SNAPSHOT_UUID",
      "campaign": { "name": "Event B", "template_id": "TEMPLATE_UUID" }
    }
  ]
}
```

Requests are processed independently and sequentially (maximum 10). This is not an atomic
batch. Mixed results use HTTP 207 and include each item's `index`, `success`, and either
`campaign`/`replayed` or `status`/`message`. Retrying with the same request IDs reuses successes.
Network/server failure can occur after some campaigns commit; reuse IDs when retrying.

Automatic sheet polling, status write-back, Apps Script menus, and a production dashboard integration
are not included in this backend release. Sheet snapshots/private import files follow the
deployment's data-retention policy; expiration prevents new imports but does not delete data.

## OAuth test page

Open `/v1/integrations/google/test` on the **same origin as GOOGLE_REDIRECT_URI**.
For ngrok, use its public HTTPS hostname rather than localhost, so the OAuth browser
cookie is sent to the callback. Sign in with an existing dashboard account owner, or
paste an existing dashboard JWT. The development login-domain hint defaults to
`localhost`; override it with `GOOGLE_TEST_LOGIN_DOMAIN` when needed.

Click **Connect Google** and complete consent in the popup. The main page polls the
connection status and reports successful token exchange. The existing callback remains
JSON-only; no credentials or tokens are embedded in its page. The test page never
creates campaigns, imports contacts or sends messages. Tokens are held in memory only;
reloading the page requires dashboard login again.

To test selection of a new spreadsheet as well, set `GOOGLE_PICKER_API_KEY` to a dedicated
browser key and `GOOGLE_CLOUD_PROJECT_NUMBER` to the same Google Cloud project's numeric
project number. Enable Google Picker and Drive APIs. Restrict the browser key to the test
origin (`https://YOUR-NGROK-HOST/*`) and `https://docs.google.com/*`, and to the Picker/Drive
APIs. Configure the test origin as an authorized JavaScript origin for the OAuth web client.
Restart the API after editing `.env`. The page reads this public Picker configuration
from its authenticated setup endpoint; the client secret and refresh token stay server-side.

Use **Choose spreadsheet**, **Load tabs**, then **Read sample rows**. Without Picker
configuration, Google OAuth can still be tested, and previously authorized spreadsheets
can be read using their ID. A fresh connection can have an empty authorized file list.

## Validation

`npm run test:google-sheets` covers OAuth session binding/replay, account isolation, token
encryption/refresh, preview snapshots, import idempotency, template ownership and campaign
request deduplication with an isolated query fixture. `npm run build` checks the integration
with the application. Live Google consent/API calls require configured credentials.

References: [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes),
[Google Picker](https://developers.google.com/workspace/drive/picker/guides/overview),
[Sheets quotas](https://developers.google.com/workspace/sheets/api/limits).
