# Company-admin live support API

Users can raise a support ticket and exchange live text messages with their own company's admins. Tickets and messages are persisted in PostgreSQL. The HTTP API writes messages; an authenticated Server-Sent Events (SSE) connection delivers updates to the user and admin dashboards. Email delivery is not required for any chat operation.

Base path: `/v1/admin/support/live`.

Every request, including the event stream, requires `Authorization: Bearer <login-JWT>`. JSON requests also require `Content-Type: application/json`. User API keys do not authenticate these endpoints. Use the existing login and token refresh flow.

## Access

- A user can create tickets and read, reply to, close, resolve, or reopen their own tickets.
- An active company admin (`admin` or legacy `company` role) can read the company's inbox, join a conversation, assign tickets to an active admin in the same company, change status, and delete tickets through the existing delete API.
- Other roles, including team members, only see their own tickets. Sharing an account owner ID does not grant access to the owner's support messages.
- A ticket assigned to another admin cannot be claimed or replied to until a company admin reassigns it. Any company admin can manage assignments and ticket status.
- The current user, company, and role come from the database, rather than body parameters or stale JWT role claims. A suspended user/company loses stream access on the next delivery or fallback check (normally within five seconds).
- The new live endpoints serve company support. The existing platform escalation APIs remain separate.

## Endpoint list

Paths below are relative to `/v1/admin/support/live`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admins` | List active support admins in the caller's company: `id`, `name`, `email` |
| GET | `/tickets` | Paginated own tickets, or the company inbox for an admin |
| POST | `/tickets` | Create a ticket/live chat and persist its first message atomically |
| GET | `/tickets/:ticketId` | Retrieve an accessible ticket |
| GET | `/tickets/:ticketId/messages` | Read a page of message history |
| POST | `/tickets/:ticketId/messages` | Persist a message and broadcast it after commit |
| POST | `/tickets/:ticketId/join` | Admin claims the conversation and marks it in progress |
| PATCH | `/tickets/:ticketId/assignment` | Admin assigns, reassigns, or unassigns a ticket |
| PATCH | `/tickets/:ticketId/status` | Resolve, close, reopen, or mark in progress |
| GET | `/events` | Live updates, optionally for one ticket, with reconnect replay |

Regular JSON responses use the existing envelope:

```json
{
  "success": true,
  "message": "Message saved",
  "data": {},
  "meta": { "timestamp": "2026-10-22T10:00:00.000Z" }
}
```

### Create a ticket or live chat

`POST /tickets`, returns HTTP 201 with the ticket in `data`:

```json
{
  "subject": "Contact import assistance",
  "message": "My contact import is stuck. Can you help?",
  "channel": "live_chat",
  "client_request_id": "4a220f01-b884-4207-8610-203583875846"
}
```

Only `message` is required. `channel` is `live_chat` by default; use `ticket` for an asynchronous support request. `subject` defaults to the first line of the message, truncated to 255 characters. Optional `admin_id` selects an active company admin; omission creates an unassigned ticket. Optional contact metadata fields are `name`, `email`, and `phone`; omitted fields use the authenticated user's profile. Sender identity on messages always comes from the authenticated user.

Keep the same `client_request_id` UUID when retrying a request after a network failure. A repeated request returns the existing ticket, without another opening message. Reusing the key with different message/subject/channel returns 409. Use a new key for a genuinely new request. Do not resend old ticket creation requests after deliberately deleting that ticket.

Messages must contain 1–10,000 characters after trimming; subjects 1–255. UUID fields must be UUID strings.

### Inbox and history

`GET /tickets?page=1&limit=20&status=open&channel=live_chat&admin_id=<UUID>`

All filters are optional. `page` defaults to 1; `limit` defaults to 20 and has a maximum of 100. Tickets sort by most recently updated. `data` is `{ items, pagination: { page, limit, total } }`.

`GET /tickets/:ticketId/messages?limit=50`

Returns the most recent messages, in ascending sequence order:

```json
{
  "items": [],
  "has_more": false,
  "next_cursor": null,
  "previous_cursor": null
}
```

The object above is inside `data`. Each item includes `id`, `ticket_id`, `sequence`, `message`, `user_id`, `user_name`, `sender_role`, `client_message_id`, and `created_at`.

- Load older messages with `before=<previous_cursor>`.
- Catch up on newer messages with `after=<next_cursor>`; `after=0` starts from the oldest message.
- Use either `before` or `after`, never both. Maximum limit is 100.
- `has_more` refers to the selected direction. Display returned items in their provided ascending order.
- Preserve sequence and event cursor values as strings. They are PostgreSQL bigint values and can exceed JavaScript's safe integer range. Message sequences and event IDs are different cursors.

### Send a message

`POST /tickets/:ticketId/messages`, returns HTTP 200 with the saved message in `data`:

```json
{
  "message": "I am checking the import now.",
  "client_message_id": "cab6b244-96fe-48bf-88ad-f678ed2e3615"
}
```

Use a fresh UUID per composed message, retaining it for retries. Repeating the same message/key acknowledges the original message. Reusing the key with different content returns 409. Both user and admin use this endpoint. The server ignores caller-supplied sender IDs/roles and broadcasts the committed message. Deduplicate the POST response and stream event by the saved message `id`.

New messages on `resolved` or `closed` tickets return 409. Reopen first. Retrying a previously acknowledged message still returns that message after closure.

### Join, assign, and change status

Admin joins: `POST /tickets/:ticketId/join` with `{}`. This claims the ticket, sets `channel=live_chat`, and sets `status=in_progress`. If two admins claim an unassigned ticket simultaneously, one succeeds and the other receives 409.

Admin assigns: `PATCH /tickets/:ticketId/assignment` with `{ "admin_id": "<company-admin-UUID>" }`. Use `{ "admin_id": null }` to unassign. The field is required.

Change status: `PATCH /tickets/:ticketId/status` with `{ "status": "resolved" }`.

Statuses: `open`, `in_progress`, `resolved`, `closed`. Only an admin can set `in_progress`. Reopen a resolved/closed ticket with `{ "status": "open" }`. A closed ticket must reopen before transitioning to another status.

## Live event connection

`GET /events` streams the caller's visible inbox. `GET /events?ticket_id=<UUID>` restricts it to an accessible ticket. Use one inbox stream per dashboard and route events to the appropriate conversation in the UI. The server allows up to five simultaneous streams per user per API instance.

The content type is `text/event-stream`. A connection starts with:

```text
id: 42
event: ready
data: {"cursor":"42","heartbeat_ms":15000}

```

A saved message produces:

```text
id: 43
event: message.created
data: {"message":{"id":"<UUID>","ticket_id":"<UUID>","sequence":"17","message":"Hello","user_id":"<UUID>","user_name":"Admin","sender_role":"admin","client_message_id":"<UUID>","created_at":"2026-10-22T10:00:00Z"},"event_id":"43","created_at":"2026-10-22T10:00:00Z"}

```

Other events are `ticket.created`, `ticket.updated`, `ticket.assigned`, `ticket.status_changed`, and `ticket.deleted`. Ticket update events contain `ticket`; a deletion contains `ticket_id`. Events contain a safe ticket summary; fetch ticket details when needed. A join can produce a status event whose ticket also contains the new assignment.

Reconnect with `Last-Event-ID: <last-applied-event-id>` or `?after=<last-applied-event-id>`. The header takes precedence. Missing cursors start from the current end of the visible event log; `after=0` replays retained history. IDs are globally allocated and may have gaps for events outside the caller's scope. Persist a cursor only after applying its event successfully; deduplicate message IDs during replay.

Use authenticated `fetch()` with a streaming reader, or an SSE client that supports authorization headers. Native browser `EventSource` cannot set the bearer header. Do not put JWTs in URLs. For cross-origin dashboards, the existing CORS middleware permits these bearer-authenticated requests.

Frontend sequence:

1. Authenticate; call `/admins` when offering admin selection.
2. Open the inbox event stream and wait for `ready`. Buffer subsequent events while loading `/tickets` and the selected ticket's message history.
3. Apply the initial snapshot, then buffered events, deduplicating message IDs. Refresh ticket lists on ticket events; their updated ordering/status may change active filters.
4. Create with `/tickets`, then have the admin call `/join`. Send messages with `/messages`.
5. On a disconnect, reconnect with the last applied event ID and a current bearer token. Keep cursors separate for each account and stream filter. Do not share a ticket-specific cursor with the inbox or another ticket. Discard cursors on logout/account change.

Comment heartbeats arrive every 15 seconds. `stream.reconnect` asks the client to refresh authentication and reconnect; streams last at most 15 minutes and never outlive the JWT. `stream.error` with `ACCESS_REVOKED` means stop reconnecting until the account is active again. `TEMPORARILY_UNAVAILABLE` permits reconnect with backoff and the saved cursor. HTTP 401 requires authentication; 403/404 requires stopping or changing the selected scope; 429 requires reducing open streams/backing off. A deleted ticket cannot start a new ticket-specific stream; the inbox can replay its deletion.

## Existing APIs

The following URLs remain available under `/v1/admin/support` and use the same scoped support service:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/tickets` | Ticket array; default limit 100, accepts list filters/page |
| POST | `/ticket` | Create, default channel `ticket`; retains HTTP 200 |
| GET | `/:ticketId` | Ticket detail |
| GET | `/:ticketId/conversation` | Message array; latest 100 by default, accepts before/after/limit |
| POST | `/:ticketId/reply` | Send message |
| PUT | `/:ticketId/resolve` | Resolve |
| PUT | `/:ticketId/close` | Close |
| DELETE | `/:ticketId` | Company-admin-only deletion |

Existing response envelopes and array shapes are retained. Lists/history are now bounded; new clients should use the paginated live endpoints. Core support operations no longer synchronously send SMTP notifications. Platform escalation/forwarding URLs keep their existing separate authorization and workflow; database triggers also publish their committed ticket/message changes to authorized company streams.

## Deployment and scaling

The new backend requires migration `20261022000001_support_live_chat.ts`. This change does not itself deploy or run the migration against production.

1. Back up the database and review outstanding migrations. The migration adds columns/indexes, backfills existing message sequences, and installs event triggers. It retains existing ticket/message rows. Backfill/index creation takes table locks; choose a suitable deployment window for large histories.
2. Build the image with `npm run build`. Run migrations once, using the same release/configuration as the API, before directing traffic to the new code. For the compiled production image:

   ```sh
   node node_modules/knex/bin/cli.js --knexfile dist/library/surefy/src/config/knex.config.js --env production migrate:latest
   ```

   `migrate:latest` applies all outstanding repository migrations; inspect the migration list first. Source/development environments can use `npm run migrate:latest`.
3. Roll out the API. Every replica must use the same PostgreSQL database. Workers do not need a new queue for this feature. Normal messages save in one transaction; PostgreSQL triggers persist replay events and send NOTIFY after commit.
4. Allow persistent HTTP responses through ingress/load balancers. Honor `X-Accel-Buffering: no`; disable response buffering for this endpoint if the proxy overrides it. Keep the idle timeout above the 15-second heartbeat interval and drain old API connections during rollouts. Reconnecting clients resume by cursor; sticky sessions are unnecessary.

Each API process opens at most one additional PostgreSQL LISTEN connection while it has live subscribers. That connection must use a direct database connection or a session-mode pool. If `DATABASE_URL` points to a transaction-mode pool, configure `SUPPORT_LISTEN_DATABASE_URL` with the direct/session-mode URL. No new environment setting is required for existing direct PostgreSQL deployments.

NOTIFY is a wake-up signal; saved events are the source of truth. A five-second fallback check recovers missed notifications and rechecks account access. Company advisory locks serialize event allocation until commit so reconnect cursors cannot skip an earlier uncommitted event. HTTP mutations lock individual tickets to protect joins and duplicate message retries.

Monitor active streams, database connections, event delivery latency, event table growth, and fallback query load before adding API replicas. The replay table contains message content and currently has no automatic retention cleanup; define retention and a snapshot/reconnect policy before pruning it. Size the API connection pool plus one listener per replica within the database connection budget. This implementation covers persisted text chat; attachments, typing indicators, read receipts, and voice/video are separate features.

## Validation

`npm run build` checks production TypeScript compilation. `npm run test:support` runs input checks and skips the database integration test unless `SUPPORT_TEST_DATABASE_URL` is provided. Use a fresh disposable local PostgreSQL database whose name contains `support_test`:

```sh
SUPPORT_TEST_DATABASE_URL=postgres://test_user:test_password@127.0.0.1:5432/support_test npm run test:support
```

The integration suite creates its own fixture tables and verifies the migration, real JWT middleware, HTTP endpoints, tenant/owner isolation, concurrent admin claims, duplicate-message handling, cross-instance SSE delivery, replay ordering across transactions, legacy writes, closure/reopening, suspension, deletion events, and upgrade/backfill of existing tables. Never point the suite at an application database.
