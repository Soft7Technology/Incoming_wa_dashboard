# Activity logs

`GET /v1/admin/activity` returns `{ data, pagination }` inside the standard API response. Rows include `user_name` and `user_email` from the actor account.

Visibility uses the authenticated token, never `?role=`:

- Users/members see their own recorded actions, not everyone in their company.
- Admin/company accounts see their company's activities and may filter by user.
- Superadmins see all activities and may filter by company/user.

Explicit company IDs always constrain results. Legacy logs missing company_id may be shown to the actor's current company via the users join. Logs missing both actor and company cannot be recovered automatically. Old team actions recorded under the owner cannot retrospectively be attributed to a member.

Supported filters:

| Parameter | Meaning |
| --- | --- |
| `search` | Case-insensitive substring of description, action, entity type, user name or email; maximum 200 characters; `%` and `_` are literal |
| `type` / `entity_type` | Exact entity type, case-insensitive, e.g. CONTACT, CAMPAIGN, CHATBOT, TEAM, SUBSCRIPTION |
| `action` | Exact action, case-insensitive, e.g. CREATE, UPDATE, DELETE, LOGIN, ACTIVATE |
| `status` | Exact status, case-insensitive |
| `user_id`, `company_id`, `entity_id` | UUID filters; never widen caller visibility |
| `read` | true or false |
| `date_from` / `start_date` | Inclusive lower date/time |
| `date_to` / `end_date` | Exclusive upper timestamp; a date-only value includes that entire UTC date |
| `time_frame` | today, yesterday, 7days, 30days, 90days; today/yesterday use UTC |
| `page`, `limit` | Positive integers; defaults 1/10; limit capped at 100 |
| `sorted_by` / `sort_by` | created_at, updated_at, entity_type, description, action, status |
| `sort_order` | asc or desc (default desc); ID breaks ties |

Filters combine with AND. `all` clears a selector, except `search=all`, which searches the literal word.

Example:

```text
/v1/admin/activity?type=CONTACT&action=CREATE&search=Alice&date_from=2026-09-01&date_to=2026-09-23&page=1&limit=25
```

`GET /user/notify` under the activity prefix returns the caller's newest 50 notifications. `GET /admin/notify` returns company-scoped notifications for admins/company accounts (global for superadmins). Both support the same search/type/action/date/read filters. `PUT /user/notify` accepts `{ "data": [{ "id": "<uuid>" }] }` or an array of UUID strings in `data`, up to 100. Only visible IDs are marked read; inaccessible IDs are ignored.

Detailed activity writes in authenticated dashboard/API requests now use the actual caller as actor and fill missing company/request metadata. Successful POST/PUT/PATCH/DELETE operations without a detailed record receive a fallback activity entry. Fallbacks exclude request/response bodies, query strings, and the activity read-notification endpoint. GET browsing, failed requests and background jobs are not automatically logged; existing login/background-specific logs remain available. Fallback writes happen after response completion and report persistence errors to the server log; this is not a durable audit outbox.

Run `npm.cmd run migrate:latest` to add company/date and user/date indexes. This migration has not been applied by this change. Tests exercise generated PostgreSQL queries, controller authorization, actor attribution, and fallback logging; no production database was modified.
