# Lead reminder API

Base URL: `/v1/admin/reminders`. All requests require the dashboard Bearer token. Account owners can access their reminders; members can access reminders for contacts currently assigned to them. Writes require the `user` or `member` role.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/templates?phone_number_id=<id>` | Approved templates for the sending number, variable keys, and support information |
| POST | `/preview` | Validate the complete form and return recipient, country code, WhatsApp recipient/sending numbers, rendered template, timezone, and next send time |
| POST | `/` | Create a reminder using the same body as preview |
| GET | `/?status=upcoming&contact_id=<uuid>&limit=25&offset=0` | Paginated schedules; filters are optional |
| GET | `/:id` | Schedule details, variables, UTC next send and local next send |
| PATCH | `/:id` | Edit upcoming, paused, or failed schedules; partial body supported |
| POST | `/:id/pause` | Pause an upcoming reminder |
| POST | `/:id/resume` | Resume a paused reminder |
| POST | `/:id/cancel` | Permanently cancel future sending |
| GET | `/:id/history?limit=25&offset=0` | Attempts with immutable recipient/template snapshots and delivery events |

Responses use the existing `successResponse` envelope. Invalid inputs/actions return 400; inaccessible resources return 404.

## Form example

Use IDs returned by the existing contact/phone APIs and the reminder template picker. `phone_number_id` accepts the internal UUID or Meta phone-number ID; schedules store the internal UUID. The contact must belong to that sending number.

```json
{
  "name": "Birthday greeting",
  "contact_id": "<contact UUID>",
  "phone_number_id": "<sending number UUID>",
  "template_id": "<approved template UUID>",
  "frequency": "yearly",
  "local_datetime": "2026-12-15T09:30:00",
  "timezone": "Asia/Kolkata",
  "variables": {
    "body.name": "Parth"
  }
}
```

For a lead follow-up use `"frequency": "once"` and a future local date/time. Variables are scoped to their template component: `body.name` fills body `{{name}}`, `body.1` fills body `{{1}}`, and `header.1` fills header `{{1}}`. The picker returns `required_variables`. All variables must be nonempty strings. Preview and create validate independently; approval and opt-out are checked again at send time.

Reminders support text, image, video and document headers, bodies, footers and static buttons. Quick-reply buttons, dynamic buttons, and other components are marked `supported: false` in the picker and rejected on save. The frontend should disable those entries.

Call `/preview` before saving and display `recipient`, `sending_number`, `preview`, `next_send_at` (UTC), `next_send_local` and `timezone`. Local values deliberately omit an offset; show them together with their IANA timezone. A preview does not reserve a send time.

## Timing and statuses

`local_datetime` is an ISO local wall-clock value with seconds and no UTC suffix or offset. `timezone` is an IANA timezone. Yearly schedules retain their original month, day and time. February 29 skips non-leap years. Nonexistent DST times are rejected when saving, and skipped if encountered in later yearly occurrences. Repeated DST times choose the earlier instant.

List statuses: `upcoming`, `sending`, `sent`, `failed`, `paused`, `cancelled`. One-time schedules become sent when Meta accepts the message, or failed on send/delivery failure. Sent does not imply delivered. Yearly schedules return to upcoming after each attempt; their past sent/failed occurrences appear in history. An expired one-time reminder must be edited to a future time before resuming. Sending and terminal cancelled/sent reminders cannot be edited; an in-flight send cannot be recalled.

History includes `scheduled_at`, `attempted_at`, `finished_at`, template and rendered preview in `snapshot`, `wamid`, `failure_reason`, and timestamped `delivery_updates` (including Meta errors). Duplicate callbacks are deduplicated. All callbacks are persisted by WAMID so a callback arriving before the send result is saved is retained. Events remain available in received order, preserving out-of-order Meta updates.

## Operation

Apply the migration before deploying API/worker code:

```sh
npm run migrate:latest
npm run build
npm run start:worker
```

Keep the normal API server running too. The existing worker process polls every ten seconds, claims due rows using PostgreSQL row locks with SKIP LOCKED, and processes up to 25 occurrences per poll. Multiple workers may run safely. Times are scheduled targets, not delivery guarantees: worker availability, backlog and Meta affect the actual attempt time. Downtime is followed by one overdue occurrence; yearly schedules then advance to the next future occurrence without replaying every missed year.

There are no automatic send retries. If the process crashes during sending, after 15 minutes without a heartbeat the reminder is paused and an unfinished attempt becomes `unknown`. Inspect the attempt and existing messages (the message UUID equals the attempt ID) before scheduling again, because Meta might have accepted the original request. Delivery callbacks do not trigger a resend. Cancel retains audit history.

No database migration or live WhatsApp send is performed by the automated unit tests.

## Request bodies for every operation

Headers for all requests:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Use the form example above for both `POST /preview` and `POST /`. Set `frequency` to `once` for a follow-up or `yearly` for a birthday/anniversary. Use real resource IDs and a future date for a one-time reminder.

`PATCH /:id` accepts only the fields you want to change:

```json
{
  "name": "Updated lead follow-up",
  "local_datetime": "2026-12-16T10:00:00",
  "timezone": "Asia/Kolkata",
  "variables": { "body.name": "Parth" }
}
```

If supplied, `variables` replaces the complete variable map; send all required keys.

`POST /:id/pause`, `POST /:id/resume`, and `POST /:id/cancel` accept an empty body or:

```json
{}
```

GET requests do not have bodies:

```http
GET /v1/admin/reminders/templates?phone_number_id=<sending-number-id>
GET /v1/admin/reminders?status=upcoming&limit=25&offset=0
GET /v1/admin/reminders?contact_id=<contact-uuid>
GET /v1/admin/reminders/<reminder-id>
GET /v1/admin/reminders/<reminder-id>/history?limit=25&offset=0
```

Import `postman/lead-reminders.postman_collection.json` for all requests, including separate one-time and yearly examples. Set the collection variables `baseUrl`, `token`, `contactId`, `phoneNumberId`, `templateId`, and `reminderId`.

## Code organization

- `reminder.route.ts`: paths, middleware, and named controller bindings.
- `reminder.controller.ts`: authenticated request context and HTTP responses.
- `reminder.service.ts`: validation, previews, and allowed state transitions.
- `reminder.model.ts`: database queries, account-scoped lookups, row locks, attempts, and delivery persistence; extends the existing BaseModel.
- `reminderScheduler.service.ts`: polling and sending through the existing message service.
- `reminderDelivery.service.ts`: typed entry point for delivery callbacks.
- `reminder.interface.ts`: request, stored reminder, status, action, and account-context types.

Services and routes do not import the database or execute query-builder operations. Schedule mutation and dispatch still share database row locks.

## Campaign-compatible parameter mapping

Create, preview and edit now accept `parameter_mapping` and `media_uploads`, as campaigns do. Existing `variables` requests remain supported. Do not supply nonempty `variables` together with `parameter_mapping`.

```json
{
  "name": "Birthday greeting",
  "contact_id": "<contact UUID>",
  "phone_number_id": "<sending number UUID>",
  "template_id": "<approved template UUID>",
  "frequency": "yearly",
  "local_datetime": "2026-12-15T09:30:00",
  "timezone": "Asia/Kolkata",
  "parameter_mapping": { "1": "fullName", "2": "2", "3": "3" },
  "media_uploads": [{ "type": "image", "url": "https://example.com/birthday.jpg" }]
}
```

Use only keys actually present in the template. `fullName`, `phone_number` and `email` resolve from the selected contact. Custom attribute names resolve from `contact.attributes`; otherwise a mapping value is literal text, matching campaign behavior. Numeric and boolean custom attributes are converted to text, including zero and false. Missing or empty required values fail validation. Named placeholders are supported, and `header.1`/`body.1` can distinguish the same number across components. Mappings are resolved again before each send using current contact details.

For headers use one `media_uploads` entry matching the template's `image`, `video` or `document` format. Supply `media_id` or a plain HTTPS `url`/`link`; documents may also include `filename`. Media IDs take precedence over URLs. No template-example media is silently substituted. The link/ID must remain available when the reminder sends; a local preview does not verify Meta access. Omit media_uploads for text-only templates.

The picker returns `required_parameter_mapping`, `required_variables`, and `required_media_type`. Preview returns `resolved_variables` plus the rendered media/text components. PATCH replaces supplied maps/arrays; switching to parameter_mapping clears old variables and switching to variables clears old mapping. Explicit null clears parameter_mapping.

Apply migration `20260929000002_reminder_parameter_mapping.ts` before deploying this version. Restart API and workers after building. No live send or migration was performed during implementation.

## Multiple contacts on the existing create endpoint

`POST /v1/admin/reminders` accepts `contact_ids` instead of `contact_id`:

```json
{
  "name": "Lead follow-up",
  "contact_ids": ["<contact UUID 1>", "<contact UUID 2>"],
  "phone_number_id": "<sending number UUID>",
  "template_id": "<template UUID>",
  "frequency": "once",
  "local_datetime": "2026-12-15T11:22:00",
  "timezone": "Asia/Kolkata",
  "parameter_mapping": { "1": "fullName" }
}
```

Supply 1?100 unique contact IDs; do not supply both contact_id and contact_ids. All contacts must belong to the selected sending number and be accessible to the caller. The same date/time and template apply to everyone. Mappings resolve individually. Optional media_uploads and legacy variables are supported as for single-contact creation.

The entire batch is validated before an atomic insert. Any validation or insert failure creates no reminders from that request. The response data is `{ "created_count": 2, "items": [...] }`, with a separate reminder ID for each contact. Each reminder has independent history and edit/pause/cancel actions. Repeating a successful request creates another batch; this endpoint does not provide request idempotency.

Existing contact_id requests retain their original single-reminder response. Preview remains a single-contact operation: call it with contact_id for each recipient. No separate bulk URL or additional database migration is required for multiple-contact creation.
