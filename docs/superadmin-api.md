# Superadmin API

Base path: `/v1/super-admin`. Send `Authorization: Bearer <superadmin-login-JWT>` and `Content-Type: application/json`. The live users table must show role `superadmin`, status `active`, and no deleted_at value; an old JWT role cannot grant access after demotion. User API keys are not accepted.

## Dashboard and detail APIs

| Method | Path                    | Result                                                                   |
| ------ | ----------------------- | ------------------------------------------------------------------------ |
| GET    | `/overview`             | Company/user/domain counts by status and company balances by status      |
| GET    | `/companies`            | Paginated company profiles and balances                                  |
| GET    | `/companies/:companyId` | Company profile, domains, user/contact totals, campaign counts by status |
| GET    | `/users`                | Users across companies                                                   |
| GET    | `/domains`              | Domains and SSL status across companies                                  |
| GET    | `/activities`           | Existing application activity logs                                       |
| GET    | `/credits`              | Credit transaction history                                               |
| GET    | `/audit`                | Audited superadmin management actions                                    |

Each collection also supports `/companies/:companyId/users`, `/domains`, `/activities`, `/credits` and `/audit` under that company path. Company path scope takes precedence over query company_id.

Company activity and plan endpoints:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/companies/:companyId/activity` | All recorded application activities for company users; alias of `/companies/:companyId/activities` |
| GET | `/companies/:companyId/subscription-plans` | Company's `subscription_plans` catalogue, including enabled and disabled plans |
| GET | `/companies/:companyId/active-plans` | Assigned `user_plans` with `active=true`, `status=COMPLETED`, `start_date <= now` and `end_date > now` |

These endpoints require an active superadmin JWT and return `{ items, pagination: { page, limit, total } }` inside the standard response's `data`. Invalid company UUIDs return 400; missing or soft-deleted companies return 404. The company in the URL takes precedence over a valid query `company_id`. Without `user_id`, results cover all company users.

All three accept `page` (default 1), `limit` (default 25, maximum 100), `user_id`, `search`, `from`, and `to` (exclusive UTC boundary). Activity search matches description/action and accepts `status`. Plan search matches `plan_name`; plan endpoints reject `status`, since catalogue plans have no status and active assignments use a fixed completed status. Unknown filters and `domain_status` return 400. Active plan rows include the purchased plan snapshot's duration, limits and usage. Expired, future, suspended, cancelled and pending assignments are excluded even if their active flag is stale. Activity lists contain recorded logs with the requested company_id and exclude soft-deleted logs.

```text
GET /v1/super-admin/companies/COMPANY_UUID/activity?page=1&limit=25
GET /v1/super-admin/companies/COMPANY_UUID/subscription-plans?search=Monthly
GET /v1/super-admin/companies/COMPANY_UUID/active-plans?page=1&limit=25
```

Pagination: `page=1&limit=25` (maximum 100). Supported common filters: `search`, `company_id`, `from`, `to` (exclusive). Dates accept YYYY-MM-DD or UTC ISO timestamps. Results use `data.items` and `data.pagination`. Ordering is created_at descending, then id descending. Counts and lists are separate queries and can change during concurrent writes.

Use `status` for company/user/domain/activity lists. `domain_status` on the company list filters companies by a matching domain's status. `user_id` selects users, activity actors or audit actors. Search matches company/user name/email/phone, domain name/hostname, or activity/credit/audit descriptions. Example:

`GET /companies?search=soft&status=active&domain_status=active&page=1&limit=25`

Private fields such as passwords, API keys, gateway secrets, webhook verification tokens and raw configuration are not included. Domain status is the stored database status; these endpoints do not contact the DNS/SSL provider or provision a domain.

## Company messaging overview

GET `/companies/:companyId/overview` returns the company profile and lifetime WhatsApp message/template counts across all its users and phone numbers. It requires the same active superadmin JWT as the other endpoints. Invalid company UUIDs return 400; missing or soft-deleted companies return 404.

Example `data`:

```json
{
  "company": { "id": "87af00e3-cdf0-4c59-9950-143dbadf5ebc", "name": "Example Company" },
  "stats": {
    "total_message": 150,
    "delivered_messages": 100,
    "failed_messages": 10,
    "received_messages": 30,
    "templates": 5,
    "message_templates": 80
  }
}
```

- `total_message`: all stored inbound and outbound messages, including queued/sent messages, excluding status `deleted`.
- `delivered_messages`: outbound messages with status `delivered` or `read`.
- `failed_messages`: outbound messages with status `failed`.
- `received_messages`: inbound messages, including those subsequently marked as read.
- `templates`: saved template definitions, excluding soft-deleted templates, across all template statuses.
- `message_templates`: outbound messages with type `template`, across all non-deleted message statuses.

Template messages overlap the other message counts. Templates are definitions, not sent messages. Messages are counted from `messages` only; campaign tracking rows are not added again. Counts are numbers, and an empty company returns zeros. Message and template counts are separate queries and can change during concurrent writes. No schema migration is required.

## Company messages and campaigns

- GET `/companies/:companyId/messages`: paginated WhatsApp messages for the company, including content, direction, type, status, errors, template/campaign references and delivery timestamps. Messages with status `deleted` are excluded. Search matches sender/recipient phone, WhatsApp message ID and error message.
- GET `/companies/:companyId/campaign`: paginated campaigns for the company, including name, description, status, recipient/send/delivery/read/failure counters, cost, failure reason and schedule timestamps. Soft-deleted campaigns are excluded. Search matches name and description. The route uses singular `campaign`.

Both require an active superadmin JWT and accept `page` (default 1), `limit` (default 25, maximum 100), `status`, `search`, `user_id`, `from` and `to` (exclusive). `user_id` matches the record's owner. Without it, all company users are included. A query `company_id` cannot override the company in the URL. Unknown filters and `domain_status` return 400. Invalid company UUIDs return 400; missing or soft-deleted companies return 404.

Examples:

```text
GET /v1/super-admin/companies/COMPANY_UUID/messages?page=1&limit=25&status=failed
GET /v1/super-admin/companies/COMPANY_UUID/campaign?page=1&limit=25&status=running
```

Both return `data.items` and `data.pagination` (`page`, `limit`, numeric `total`), sorted by `created_at` descending, then `id` descending. Empty results return `items: []` with `total: 0`. These are read-only endpoints and require no new migration.

## Company user dashboard

All paths below use base `/v1/super-admin` and require an active superadmin JWT:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/companies/:companyId/:userId` | User profile with assigned plan snapshot and contact/campaign counts; alias of `/companies/:companyId/users/:userId` |
| GET | `/companies/:companyId/:userId/activity` | Paginated activity logs for this user |
| GET | `/companies/:companyId/:userId/campaign` | Paginated campaigns owned by this user |
| GET | `/companies/:companyId/:userId/messages` | Paginated messages owned by this user |
| GET | `/companies/:companyId/:userId/overview` | `{ user, stats }` with the same messaging metrics as company overview, scoped to this user |
| GET | `/companies/:companyId/:userId/contacts` | Paginated contacts owned by this user, including custom fields, source, validity and opt-out state |
| GET | `/companies/:companyId/:userId/active-plan` | `{ active_plan }` with the user's current plan snapshot, limits and usage, or `active_plan: null` |

Invalid company/user UUIDs return 400. Missing or soft-deleted companies/users, and users belonging to a different company, return 404. Existing named company routes such as `/companies/:companyId/users` retain their original behavior.

The four collection endpoints accept `page` (default 1), `limit` (default 25, maximum 100), `search`, `status`, `from` and `to` (exclusive UTC boundary), and return `data.items` and `data.pagination`. Valid query `company_id` and `user_id` values cannot override either URL identifier. Unknown filters and `domain_status` return 400. Results are ordered by `created_at` descending, then `id` descending. Soft-deleted contacts, campaigns and activities, and messages with status `deleted`, are excluded. Contact search matches name, email and phone number. Contacts owned by another user are excluded even when assigned to the requested user.

User overview excludes deleted messages and template definitions. Its `templates` count includes definitions attached to non-deleted WABA accounts owned by the requested user in this company; it does not assume a `templates.user_id` column. Counts use the definitions documented under company messaging overview.

An active plan must have `active=true`, `status=COMPLETED`, `start_date <= now` and `end_date > now`. Expired, future, suspended, cancelled and pending plans are excluded even when the assignment pointer or active flag is stale. No active plan is a successful HTTP 200 response:

```json
{
  "success": true,
  "message": "No active plan",
  "data": { "active_plan": null }
}
```

With an active plan, the message is `User active plan retrieved` and `data.active_plan` contains the purchased plan snapshot. The response also includes the standard `meta.timestamp`. No new migration is required.

```text
GET {{prod_url}}/v1/super-admin/companies/{{companyId}}/{{userId}}
GET {{prod_url}}/v1/super-admin/companies/{{companyId}}/{{userId}}/activity?page=1&limit=25
GET {{prod_url}}/v1/super-admin/companies/{{companyId}}/{{userId}}/campaign
GET {{prod_url}}/v1/super-admin/companies/{{companyId}}/{{userId}}/messages
GET {{prod_url}}/v1/super-admin/companies/{{companyId}}/{{userId}}/overview
GET {{prod_url}}/v1/super-admin/companies/{{companyId}}/{{userId}}/contacts
GET {{prod_url}}/v1/super-admin/companies/{{companyId}}/{{userId}}/active-plan
```

## Create a company and its initial administrator

POST `/companies`:

```json
{
  "name": "Example Company",
  "email": "company@example.com",
  "phone": "+919876543210",
  "user": {
    "name": "Company Admin",
    "email": "admin@example.com",
    "password": "ReplaceWithAStrongPassword123!"
  },
  "reason": "Approved company onboarding"
}
```

Creates an active company with zero balance, an active admin with a hashed password, and the existing free-trial plan definition. All records and the audit entry commit together. This does not issue an API key, send an email, activate a paid subscription or provision DNS.

PATCH `/companies/:companyId`:

```json
{ "name": "Updated Company Name", "phone": "+919876543210", "reason": "Requested profile correction" }
```

Editable company fields: name, email, phone, business_id. Status and balances have dedicated endpoints; arbitrary fields are rejected.

## Suspend or reactivate

PATCH `/companies/:companyId/status`:

```json
{ "status": "suspended", "reason": "Account review" }
```

Use `active` to reactivate, or `inactive` to disable. A suspended/deleted company cannot use authenticated dashboard routes; the main message send paths recheck company and sender status before contacting Meta. Already in-flight sends cannot be recalled. API-key authentication already requires active accounts. Company status changes also set every non-deleted company user to the same status in one transaction. Reactivation reactivates separately suspended or inactive users too; deleted users remain unchanged. Companies containing a superadmin cannot be disabled through this API.

PATCH `/companies/:companyId/users/:userId/status`:

```json
{ "status": "active", "reason": "User review completed" }
```

The same endpoint accepts `suspended` or `inactive`. User must belong to the company. Superadmin accounts cannot be edited through these management endpoints.

PATCH `/companies/:companyId/users/:userId`:

```json
{ "name": "Updated User", "email": "updated@example.com", "reason": "Profile correction" }
```

User profile fields: name, email, phone. Role escalation and password resets are not available here.

## Add company credits

POST `/companies/:companyId/credits`:

```json
{
  "amount": "1000.00",
  "request_id": "ae815512-cf4b-4e7e-8472-16d3c2d4bb18",
  "reason": "Approved manual wallet top-up"
}
```

Generate a new UUID request_id for each intentional addition. Reuse the same ID, actor, amount and reason when retrying the same request. A duplicate returns the original transaction without another credit. Reusing the ID with different details is rejected. The company row is locked; SQL decimal arithmetic, the credit ledger and the audit entry commit in one transaction. This is a manual credit entry, not a payment charge or refund. Existing legacy wallet endpoints retain their own behavior and should not be used concurrently for manual adjustments.

## Delete a company

DELETE `/companies/:companyId` with JSON body:

```json
{ "reason": "Company closure approved" }
```

Soft deletion preserves users, accounting records and audit history; the company becomes inactive and disappears from active company lists. No hard deletion, DNS teardown or automatic refund occurs. Global user/domain lists still show retained child records with their company_id. There is no restore endpoint in this version.

## Deployment and verification

Apply `20260930000005_superadmin_audit.ts` before deploying the new routes. It creates the transactional audit table and the unique credit-request index. No migration or production mutation was run during development. Build and mocked unit tests do not substitute for staging database/integration tests.

Implementation: `superAdmin.route.ts` -> `superAdmin.controller.ts` -> `superAdmin.service.ts` -> `superAdmin.model.ts`; DTOs and validation live in separate files. SQL stays in the model. Existing customer-facing routes remain mounted.

## Subscription and platform reporting

All paths below use `/v1/super-admin` and the existing live superadmin guard.

| Method | Path                               | Purpose                                                                                      |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/subscriptions/overview`          | Recorded receipts, platform fees and subscription counts by status/active flag               |
| GET    | `/subscriptions/revenue`           | Total recorded subscription receipts by currency and platform commission                     |
| GET    | `/subscriptions/revenue/companies` | Paginated company-by-company receipt and commission totals, including zero-revenue companies |
| GET    | `/subscriptions`                   | Purchased/assigned user plan history                                                         |
| GET    | `/subscription-plans`              | Global and company plan catalogue                                                            |
| GET    | `/payments`                        | Payment order history, including status, test flag and fulfillment timestamp                 |

Filters: company_id, user_id, from, to; list endpoints use page/limit. Company revenue supports search by company name. Subscription/payment/ticket lists support status; plan catalogue does not have a status filter. Subscription/plan searches match plan_name. Revenue status is fixed to paid and cannot be overridden. Dates are UTC; to is exclusive. Overview subscription counts use subscription created_at while receipts use paid_at and commissions use ledger created_at.

Example: `GET /subscriptions/revenue/companies?from=2026-09-01&to=2026-10-01&page=1&limit=25`

Revenue definitions:

- `subscription_receipts`: sum amount_paise for paid, non-test company_payment_orders with user_plan_id. `amount_minor` is an integer string in the currency's minor unit (paise for INR), grouped by currency; currencies are never added together. Paid but unfulfilled orders remain receipts; inspect payments.fulfilled_at for entitlement activation.
- `platform_commission`: absolute amounts from only the debit side of subscription_commission entries. Do not also sum matching credit entries. This ledger currently records INR fees and includes manual plan assignment fees as well as payment-fulfilled fees. These are wallet fee earnings, not another payment-gateway receipt.
- Results are gross recorded totals, not net revenue after refunds, tax, gateway fees or chargebacks. No refund ledger is joined. Legacy sales without payment orders are not invented from plan prices. A historical company remains in financial reports after soft deletion.
- Do not add company receipts and platform commission together. A dashboard should label them separately.

## Forwarded support tickets

| Method | Path                               | Purpose                                              |
| ------ | ---------------------------------- | ---------------------------------------------------- |
| GET    | `/tickets`                         | Paginated tickets across companies                   |
| GET    | `/tickets/forward`                 | Only tickets with a forward_superadmin assignment    |
| GET    | `/tickets/:ticketId/conversations` | Ticket metadata and paginated messages, oldest first |
| GET    | `/tickets/:ticketId/forward`       | Compatibility alias for conversation                 |
| POST   | `/tickets/:ticketId/forward`       | Assign/reassign to an active superadmin              |
| POST   | `/tickets/:ticketId/forward/reply` | Save a reply as the actual authenticated superadmin  |
| PATCH  | `/tickets/:ticketId/status`        | open, resolved or closed                             |

Ticket lists accept company_id, user_id (ticket creator), status, assigned_to (superadmin UUID), forwarded=true/false, from/to, page/limit. Any live superadmin can manage the queue; assignment is a routing hint, not an access boundary. A closed ticket must be reopened before replying.

Forward body:

```json
{ "superadmin_id": "TARGET_SUPERADMIN_UUID", "reason": "Escalated billing issue" }
```

Reply body:

```json
{ "message": "We are reviewing this billing issue.", "reason": "Support response" }
```

Status body:

```json
{ "status": "resolved", "reason": "Issue confirmed fixed" }
```

Ticket changes and audit entries commit together. Reply bodies are stored in conversations, not copied into audit changes. These endpoints do not send email. They require the existing superadmin_audit_logs migration.

The legacy `/v1/admin/support/:ticketId/forward` now requires superadmin_id and reason too. A company admin may escalate its own company tickets; other users may escalate only their own ticket in their company. Legacy forwarded-list/read/reply routes now require a live superadmin. Existing non-forwarded customer support routes are unchanged.

## Existing superadmin API review

Company CRUD/status, user status, wallet additions/history and activity reads now have dedicated superadmin endpoints. Subscription and payment reporting and support escalation are covered above. The legacy `/credits/superadmin/transaction` now explicitly requires the superadmin role.

Other distinct operations remain at their existing endpoints: `/v1/auth/create-admin` for admin creation, company domain approval/provisioning for external DNS changes, subscription plan authoring/assignment, payment verification and refunds. They are not aliases to the reporting endpoints; copying their legacy mutation handlers would bypass the new audit/validation conventions. Destructive database cleanup is not exposed through the new dashboard group. This review does not claim all legacy endpoints have been rewritten or security-audited.


## Assigned plan in user lists

`GET /v1/super-admin/companies/:companyId/users` and `GET /v1/super-admin/users` include `assigned_plan` and `plan_details` for each user. `plan_details` contains the assigned user_plans snapshot: id, user_id, company_id, subscription_id, plan_name, price, billing_cycle, status, active, start_date, end_date, duration_days, limits and usage. This is the user's purchased/assigned plan, not the current catalogue price. Expired or cancelled assignments remain visible with their actual status. Missing, unassigned or mismatched-owner plans return null. Existing search and pagination are unchanged.

## Superadmin user plan management

All routes use the live superadmin JWT guard and the `/v1/super-admin` prefix.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/available-plans?company_id=COMPANY_UUID&page=1&limit=25` | Active catalogue plans belonging to the supplied company, including features |
| GET | `/companies/:companyId/users/:userId/available-plans?page=1&limit=25` | Active catalogue plans belonging to the target user's company, including features |
| POST | `/companies/:companyId/users/:userId/plans` | Assign an active company catalogue plan and create its user plan snapshot |
| GET | `/companies/:companyId/users/:userId/plans/:userPlanId` | Individual user plan details, including limits, usage, dates and assigned user |
| PATCH | `/companies/:companyId/users/:userId/plans/:userPlanId/status` | Suspend or resume an existing user plan |

Assignment body:

```json
{ "subscription_id": "CATALOGUE_PLAN_UUID", "reason": "Approved plan assignment" }
```

Pass the target user's `company_id` to `/available-plans`; a valid company UUID is required. Missing, invalid or unknown query parameters are rejected; nonexistent or deleted companies return 404. The existing user-specific route is also supported. Both routes return active `subscription_plans` catalogue records for assignment. Select `subscription_id` from the available-plans response. The response contains `plan.id`, the new user plan UUID; this is also saved to `users.assigned_plan`. Catalogue IDs and user plan IDs refer to different tables. Assignment retains existing duration, usage snapshot, wallet commission and replacement rules: Monthly costs 100 wallet credits in platform fees, Yearly costs 1000, Free costs zero. Assignment and its audit commit together. User account status is preserved.

Status body:

```json
{ "status": "suspended", "reason": "Subscription review" }
```

Use `active` to resume. Suspension sets `active=false` and preserves status, dates, limits and usage. Suspension does not pause the expiry clock or refund wallet fees. Reactivation requires a COMPLETED plan within its original dates and no other active plan; it updates `users.assigned_plan` without charging another fee. Expired, cancelled, future and unpaid plans cannot be resumed. Assign a new catalogue plan to renew instead. User and company account statuses remain independent of subscription activation. Deleted users and mismatched company/user/plan ownership are rejected. Superadmin user plans cannot be mutated here. Status changes and audit entries commit in one transaction.

Postman examples are in the User plan management folder of `postman/superadmin.postman_collection.json`.

## Individual user details

`GET /v1/super-admin/users/:userId` returns an allowlisted user profile and its assigned plan in `data.user`, with `data.stats.contacts_count`, `campaigns_count`, and `campaigns_by_status` (status/count entries). `GET /v1/super-admin/companies/:companyId/users/:userId` also validates that the user belongs to the company in the path. Both require the existing live superadmin JWT guard.

Counts include only non-deleted records owned by that user and matching that user's company; campaigns assigned to the user but owned by another user are excluded. Campaign totals are the sum of the status groups. Users with no records return zero counts and an empty status array. Missing or deleted users return 404. Plan details are null for an absent or mismatched assignment; expired/suspended snapshots retain their actual status. Passwords, API keys, gateway credentials and raw user settings are not returned. Counts and profile reads may change during concurrent writes.
