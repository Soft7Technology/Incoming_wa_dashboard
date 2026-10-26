# Public Meta workspaces

The following pages open directly, without an application email, password, company
domain, dashboard JWT, review account or shared customer credentials:

- `/v1/facebook/page` — Messenger
- `/v1/facebook/posts` — Page posts
- `/v1/facebook/leads` — Lead Forms
- `/v1/facebook/instagram` — Instagram inbox, comments and publishing
- `/v1/facebook/ads` — Business portfolios, ad performance and paused campaign creation

Visitors still authorize their own Facebook or Instagram accounts through the
existing Meta OAuth flow. Connecting an account does not grant access to other
visitors' connections or existing dashboard customers' data.

## Browser workspace

The shared `session.js` calls `POST /v1/facebook/session` automatically. The backend
creates a separate company/owner scope and an opaque HttpOnly cookie for a new
visitor, or resumes the existing scope when its cookie is valid. These ownership
records have no email/password login. The database stores only the cookie's SHA-256
hash. No ordinary dashboard JWT is issued or accepted by these public routes.

The cookie is scoped to `/v1/facebook`, uses SameSite=Lax, is Secure on production
HTTPS, and expires after 30 days. Opening a workspace renews its lifetime. The
same cookie is used across the four pages and survives the Meta OAuth redirect.
Keep the page and API on the same origin. A different browser, cleared cookies or
an expired session starts an empty workspace; it does not recover or transfer an
older workspace's connections. Existing ownership-conflict checks still apply.

The browser calls these feature API bases:

| Feature | Public browser API |
| --- | --- |
| Messenger | `/v1/facebook/api/messenger` |
| Page posts | `/v1/facebook/api/posts` |
| Lead Forms | `/v1/facebook/api/leads` |
| Instagram | `/v1/facebook/api/instagram` |
| Business & Ads | `/v1/facebook/api/ads` |

These routes resolve ownership from the cookie and reuse the existing controllers
and services. Cross-origin browser requests are rejected. The existing
`/v1/admin/*` endpoints retain their JWT and account permission requirements.
OAuth state validation, token encryption, Page/account ownership checks, messaging
windows and signed webhooks are unchanged. Existing dashboard connections are not
automatically displayed in a new visitor workspace.

## Deploy

Apply `20261023000001_create_public_meta_sessions.ts` using the existing migration
process, build with `npm run build`, and restart the API. The build copies
`session.js` alongside the existing public pages. No review-login credentials or
public-review environment switches are needed for the new browser flow. Keep the
existing Meta app credentials, encryption keys, callback URLs and permission
configuration for each feature.

Opening a public page creates a workspace, but does not publish a post or send a
message. Those operations still require an authorized connection and an explicit
visitor action. Meta's own consent and account eligibility requirements continue
to apply.
