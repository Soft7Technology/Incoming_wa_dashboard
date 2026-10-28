# Dynamic plans and wallet add-ons

The platform superadmin owns feature registration, shared packs and all add-on prices. Company administrators can also create their own company-owned WABA, Chatbot and TeamInvite packs, editing pack limits without controlling prices. They create plans and assign them using the existing assignment endpoints. A company administrator buys extra units for a specific user's current paid plan from the company wallet. The platform wallet receives the same amount.

Endpoints use the existing JWT authentication. Company subscription endpoints start with `/v1/admin/subscription`; superadmin pricing endpoints below start with `/v1/super-admin/billing`.

## Importable add-on API collection

Import [the plan add-ons Postman collection](../postman/plan-addons.postman_collection.json). Set its `base_url` (origin without `/v1`), `superadmin_token`, `admin_token`, recipient `user_id`, and `subscription_plan_id` when editing a catalog definition. It includes catalog management, plan selection switches, the company charge feed, entitlements, wallet purchases, disabling/restoring packs, and optional future feature registration. Default WABA/chatbot/team packs contain one unit each; the contacts pack contains 3,000 contacts. Each starts at INR 20 (`price_paise: 2000`). Superadmin can change pack prices through the existing PATCH API; registration never overwrites those changes.

1. As superadmin, create/reuse the WABA and Chatbot packs. Create responses automatically save `waba_addon_id` and `chatbot_addon_id` in collection variables. Creating/editing a pack does not charge a wallet.
2. As company admin, fetch charges and the recipient's entitlements. The entitlements request saves `user_plan_id`, the assigned plan UUID. Use an active, unexpired paid assignment with the corresponding included, enabled, finite feature limit. Paid catalog definitions created inactive during registration must first be published and assigned through the existing plan flow.
3. Send the WABA purchase and/or Chatbot purchase. At one unit per pack and INR 20 per pack, each request charges INR 20 from the company wallet; buying both charges INR 40. The server reads the current superadmin catalog price. If the superadmin changes a pack to INR 30 before a new purchase, that purchase charges INR 30. Client-supplied prices are rejected. A purchase is not a previously locked frontend quote: refresh the charge feed and show the returned `amount_paise` in the receipt.
4. Refresh entitlements. For a Pro assignment, one of each pack changes WABA capacity 3 to 4 and Chatbot capacity 10 to 11. This increases allowance; it does not create a chatbot, register a Meta phone, or automatically activate an existing inactive phone. Existing resource APIs still perform those actions.

Each purchase request generates its own `Idempotency-Key` once and retains it for retries. For another intentional purchase, clear/set a new corresponding `*_purchase_key` variable. Retrying the same key and body returns the saved purchase without charging again; changing the body with the old key is rejected. The generic purchase example is an additional purchase, not a prerequisite for the two specific examples.

Subscription create/update accepts `addons: [{ "addon_id": "<pack UUID>", "enabled": true }]`. These are pack selections, not prices or already-purchased capacity. Company admins can select shared packs or their own company-owned packs; other companies' packs are hidden and rejected. Purchase adds units to the assigned plan's `addon_limit`; the base feature limit stays the same. Per-plan prices are not accepted. Add-ons expire at assignment expiry and are charged once, without automatic renewal or proration. They are not added to each future subscription renewal charge. Existing purchases preserve their recorded price after catalog changes. Free plans, disabled features and unlimited features cannot purchase corresponding packs.

## Company admin creates and edits add-on packs

Apply `20261019000009_company_owned_addons.ts` before deploying this flow. Existing packs keep NULL `company_id` and remain the shared superadmin catalog. New company-owned packs use the authenticated company and creator IDs. No existing pack ownership, units, prices or purchase receipts are rewritten.

Company admins can create packs for **WabaNumber**, **Chatbot**, and **TeamInvite**. `units` is the extra capacity per purchased pack, not the plan's base limit. Every new company-owned pack starts at **2000 paise / INR 20 per pack**, regardless of its units. For example, `units: 3` is three extra seats for INR 20 per pack until superadmin changes that pack's price. A purchase quantity of two buys six seats for INR 40 at that price.

```http
POST /v1/admin/subscription/addons
Authorization: Bearer <company-admin-JWT>
Content-Type: application/json
```

```json
{
  "name": "Extra team members",
  "feature_key": "TeamInvite",
  "units": 3,
  "active": true
}
```

Use `feature_key: "WabaNumber"` or `"Chatbot"` for those packs. Accepted aliases continue to normalize to canonical keys. The response's `data` contains the saved `id`, `company_id`, `created_by`, `price_paise: 2000`, and `editable: true`. Do not send `price_paise`, company/user ownership IDs or `default_key`: those fields are rejected. Non-admin company users cannot create/edit packs.

```http
PATCH /v1/admin/subscription/addons/<company-owned-pack-UUID>
```

```json
{ "name": "Extra 5 team members", "units": 5, "active": true }
```

PATCH accepts any non-empty subset of `name`, `units`, and `active`. `feature_key` is fixed after creation. Admin edits never reset a price previously changed by superadmin. `DELETE /v1/admin/subscription/addons/:id` disables an owned pack; PATCH `{ "active": true }` restores it. Shared packs and other-company packs cannot be edited through these company APIs.

Only superadmin changes the price, using the same pack UUID:

```http
PATCH /v1/super-admin/billing/addons/<company-owned-pack-UUID>
```

```json
{ "price_paise": 3000 }
```

Future purchases of that pack now cost INR 30. A later company-admin units/name edit preserves INR 30. Superadmin's existing add-on list includes all companies' packs and shared packs, with `company_id` identifying ownership.

For the company add-on management page, fetch `GET /v1/admin/subscription/addons?include_inactive=true`. It returns shared packs plus that company's packs, and `editable` identifies rows the company admin may edit. Show price read-only on every company-admin row. Show create/name/units/status controls for owned rows only. The charges feed and plan form use the same company visibility boundary. An owned pack can then be selected using the existing plan `addons` array shown below. Creating/editing a pack does not assign a plan, buy capacity or debit a wallet; admin edits and their audit records commit together.

The collection contains placeholder credentials only. Its requests use the existing APIs; generating/importing the collection does not create live packs or debit wallets.

## Add-on switches in the plan form

Migration `20261019000008_plan_addon_selections.ts` registers four shared default packs: `default_key` values `waba_number`, `chatbot`, `team_member`, and `contacts_3000`. New-company registration also ensures those packs exist, without duplicating packs or changing their edited prices/status. It returns the catalog as `freePlan.addon_catalog`. New Basic/Pro/Enterprise defaults select all four available default packs; Free selects none. The paid definitions themselves still start with `active: false`.

For a **new plan**, fetch `GET /v1/admin/subscription/addons` using the admin JWT. Each active visible catalog row contains `id`, `name`, `feature_key`, `units`, `price_paise`, `active`, `default_key`, `company_id`, `editable`, and `enabled: false`. Render a table with an enable switch, feature, pack size and INR price (`price_paise / 100`). Match switches to `row.id`. Offer "Enable all" / "Disable all" by changing form state; this does not call a wallet purchase API. Enable rows only for included finite features on a paid plan.

For **editing**, call `GET /v1/admin/subscription/addons?plan_id=<company-owned catalog plan UUID>`. This returns the saved `enabled` flags, including disabled catalog rows so previous selections remain visible. A pack with `active: false` cannot be newly enabled or purchased. The plan lookup checks the authenticated company; a request cannot select another company's definition. Do not use an assigned `user_plan_id` in this query.

Submit the selections with the normal `POST /v1/admin/subscription/plan` or `PUT /v1/admin/subscription/plan/:id` payload:

```json
{
  "addons": [
    { "addon_id": "<WABA pack UUID>", "enabled": true },
    { "addon_id": "<Chatbot pack UUID>", "enabled": true },
    { "addon_id": "<Team member pack UUID>", "enabled": false },
    { "addon_id": "<3,000 contacts pack UUID>", "enabled": true }
  ]
}
```

This partial payload is sufficient for PUT; POST also requires the normal plan name, price, billing cycle, description, active flag and feature limits. `addons` replaces the whole selection list. On update, omit it to preserve the list or send `[]` to disable all packs. On create, omission defaults to `[]`. Send boolean `enabled` values, unique real UUIDs, and no `price_paise`, `units` or company/user IDs inside a selection. Enabled unavailable packs, missing/disabled/unlimited features and enabled Free-plan selections are rejected before saving. Disabled rows may remain in the list.

Enabling a row only makes the pack available for purchase; it does not increase a limit, debit a wallet, or change the subscription's base price. For example, a Pro catalog definition at INR 200 remains INR 200 when the WABA and Chatbot switches are enabled. Buying one pack of each at INR 20 later costs INR 40 and raises WABA capacity 3 to 4 and Chatbot capacity 10 to 11. Buying one contacts pack raises 20,000 to 23,000.

Assignment, renewal and checkout snapshot the selected `addons` into `user_plans`, alongside feature limits. `GET /v1/admin/subscription/entitlements?user_id=<UUID>` exposes that snapshot in `data.addons`. A disabled or unselected pack cannot be purchased for that assignment (`PLAN_ADDON_DISABLED`, HTTP 403). Editing a catalog definition changes future assignments, not existing snapshots. Disabling a pack globally as superadmin blocks future purchases across all plans; existing purchased capacity/receipts remain valid. Historical plan definitions and assignments retain SQL `NULL` selections and their previous feature-based eligibility until explicitly replaced; clients should treat `data.addons: null` as that legacy behavior, not as an empty list.

## Superadmin platform fees and add-on charges

`GET /v1/super-admin/billing/platform-fees` returns the current global policy. Only superadmin can update it:

```http
PUT /v1/super-admin/billing/platform-fees
Authorization: Bearer <superadmin-token>
Content-Type: application/json
```

```json
{
  "monthly_fee_paise": 14900,
  "yearly_fee_paise": 149000
}
```

These are fixed INR wallet charges per paid plan assignment/activation, distinct from the customer's subscription price. Amounts are integer paise: `14900` means INR 149. Zero waives the platform fee; Free plans always charge zero. Both fields are required for PUT. Negative values, fractional paise, string amounts, unknown fields and amounts above 100000000 paise return HTTP 400. Non-superadmin mutations return HTTP 403. The migration initially preserves the old INR 100 monthly / INR 1000 yearly platform fees.

`POST /v1/super-admin/billing/addons` creates a pack:

```json
{
  "name": "Extra team member",
  "feature_key": "TeamInvite",
  "units": 1,
  "price_paise": 5000
}
```

Use the same API for every feature:

| Feature | Canonical `feature_key` | Example units |
| --- | --- | --- |
| Team members | `TeamInvite` | 1 |
| Contacts | `Contact` | 1000 |
| Campaigns | `Campaign` | 10 |
| WABA numbers | `WabaNumber` | 1 |
| Chatbots | `Chatbot` | 1 |
| AI assistants | `AiAssistant` | 1 |

`TeamMembers`, `WABANumber`, and `AIAssistant` are also accepted aliases on pack creation. Set the price separately for each pack. Packs remain dynamic: `GET/POST /v1/super-admin/billing/features` reads/registers feature definitions, and a registered feature can have its own packs.

`GET /v1/super-admin/billing/addons` includes active and disabled packs. Edit a pack with:

```http
PATCH /v1/super-admin/billing/addons/ADDON_UUID
```

```json
{
  "name": "Extra team member",
  "units": 1,
  "price_paise": 7500,
  "active": true
}
```

PATCH accepts any non-empty subset of these four fields. `feature_key` is immutable; create another pack to change the feature. Units and add-on prices must remain positive integers. `DELETE /v1/super-admin/billing/addons/ADDON_UUID` disables a pack without deleting historical purchases.

For the company admin panel, fetch **`GET /v1/admin/subscription/charges`**, with an admin JWT and no body. Its `data` contains `currency: "INR"`, `platform_fees`, `features`, `addons`, `platform_fee_applies_to: "paid_plan_assignment_or_activation"`, and `addon_charge_type: "one_time_until_plan_expiry"`. Disabled packs are omitted; platform fees include `free_fee_paise: 0`. The response sets `Cache-Control: no-store`. Refetch after pricing changes or when opening the purchase form so the panel displays current charges.

Company admins buy packs through the existing `POST /v1/admin/subscription/addon-purchases` with `Idempotency-Key` and `{ "user_id": "USER_UUID", "user_plan_id": "ACTIVE_PLAN_UUID", "addon_id": "ADDON_UUID", "quantity": 1 }`. Server catalog prices determine the debit; client-supplied prices are rejected. Add-ons are charged once and expire with the assigned plan; they are not automatically renewed or prorated. An unlimited/disabled feature or a Free plan cannot buy extra capacity.

Price changes apply to future purchases. Existing purchases retain saved units, charges and expiry. A pending checkout stores its quoted platform fee in `user_plans.platform_fee_paise`; later policy changes cannot reprice that checkout. Existing pending checkouts are backfilled with their legacy fee. Paid checkout verification debits the quoted platform fee once, and manual assignment uses the current policy. Neither policy edits nor catalog edits charge wallets by themselves. Fee changes and pack edits have transactional pricing audit records.

Apply `20261019000003_platform_pricing.ts` before using these APIs. If older unrelated migrations are blocked, apply only this migration with `npm run knex -- migrate:up 20261019000003_platform_pricing.ts` after the dynamic plan/add-on migration is present, then build and restart the API/workers. Do not bypass unresolved contact-data migrations by editing their history.

## Create the requested plan

Plan names can be any non-empty string. Use a free-text name field. `GET /v1/admin/subscription/plan-options` with the existing JWT provides optional suggestions:

```json
{
  "success": true,
  "message": "Subscription plan options",
  "data": {
    "plan_names": [
      { "label": "Free", "value": "Free" },
      { "label": "Basic", "value": "Basic" },
      { "label": "Pro", "value": "Pro" },
      { "label": "Enterprise", "value": "Enterprise" }
    ],
    "custom_names_allowed": true
  }
}
```

Submit the chosen name as `plan_name` in the existing create/update payload. Custom names such as `Starter`, `Free Trial`, `pro`, and names in other languages are accepted and preserved as supplied. Empty, whitespace-only and non-string names return HTTP 400 with `plan_name must be a non-empty string`. Name and billing cycle are separate fields; monthly and yearly definitions can share the same name.

New registration trials use `plan_name: "Free"`. When editing a plan, display its current name and allow any custom replacement; omit `plan_name` to leave it unchanged. Partial price/description/duration edits continue to work. Renaming a catalog definition does not rename already assigned snapshots. No database migration is needed for custom names.

`POST /plan`

```json
{
  "plan_name": "Pro",
  "price": 200,
  "billing_cycle": "Monthly",
  "description": "Pro plan",
  "active": true,
  "marketing_features": ["24/7 Customer Support", "Priority onboarding"],
  "features": {
    "TeamInvite": { "limit_value": 2 },
    "Contact": { "limit_value": 20000 },
    "Campaign": { "limit_value": null },
    "WabaNumber": { "limit_value": 3 },
    "Chatbot": { "limit_value": 10 },
    "AiAssistant": { "limit_value": null }
  }
}
```

`true` is a JSON boolean; `**true**` is invalid JSON. Plan `price` is in INR. Set `billing_cycle` to `Yearly` and supply the annual price for an annual plan. Monthly and annual prices are separate plan records. The API does not multiply the monthly price by twelve.

`limit_type` is still accepted for compatibility, but the feature key identifies what is limited. `TeamMembers`, `WABANumber`, and `AIAssistant` are accepted aliases for `TeamInvite`, `WabaNumber`, and `AiAssistant`.

| Configuration | Meaning |
| --- | --- |
| `limit_value: 2` | Allow 2 units |
| `limit_value: null` | Unlimited |
| `limit_value: 0` | No units |
| `enabled: false, limit_value: 0` | Feature disabled |
| Omitted quota-controlled feature | Disabled for newly assigned plans |

The optional `enabled` flag defaults to `true`. Updating `features` replaces the whole feature map; omitting `features` preserves it. Tags, messages, and custom contact columns are always unrestricted by subscription quotas. Do not include them in `features`, plan limit controls, or add-on selectors. Historical payload keys for these resources are ignored; the feature catalog and entitlement summary omit them. Contact creation/import and the other quota-controlled resources still enforce their existing limits. Authentication, ownership checks, bulk request safety limits, and Meta messaging requirements still apply.

Migration `20261020000001_unmetered_tags_messages_columns.ts` removes these quota fields from existing `subscription_plans.features` and `user_plans.limits`, `usage`, and `usage_periods`. It removes their plan add-on selections and retires their catalog entries without deleting purchased receipts, contacts, tags, messages, columns, or wallet history. Other feature limits and plan prices/dates remain intact. Previous configurations are saved in `unmetered_plan_features_audit`; rollback refuses to overwrite subsequent plan changes. Deploy this migration before serving the updated API. The frontend should render configurable features from `GET /v1/admin/subscription/features`, which excludes these resources.

## Billing and limits

The feature registry distinguishes stored capacity from usage:

| Key | Type | What counts |
| --- | --- | --- |
| `TeamInvite` | Capacity | Pending and accepted invitations, excluding the owner |
| `Contact` | Capacity | Stored contacts excluding soft-deleted rows |
| `Campaign` | Usage | Campaigns created during the billing period |
| `WabaNumber` | Capacity | Connected phone numbers excluding soft-deleted rows; not WABA account count |
| `Chatbot` | Capacity | Stored chatbots including drafts |
| `AiAssistant` | Capacity | Stored assistants including inactive assistants; not tokens or AI replies |

Usage quotas follow billing: monthly for Monthly plans and yearly for Yearly plans. The server derives `reset_period`; the form does not need a separate period input. Reset boundaries use the plan start anniversary in UTC, with month-end/leap-year clamping. Resets are calculated when checking/consuming usage, so no cron job is required. The existing subscription renewal/assignment flow starts a fresh plan snapshot; this does not automatically renew a subscription or charge a wallet.

Capacity represents resources that still exist. On renewal, the plan's base capacity applies again and existing resources still occupy it. For example, renewing a 2-member plan with 2 existing members leaves 0 available seats. Deleting a member releases a seat. A downgrade never deletes resources; new creation is denied until usage fits the limit or an add-on is purchased.

Manual contact creation and spreadsheet imports enforce the contact limit. Existing automatic inbound-contact capture remains available so receiving WhatsApp messages does not fail due to contact capacity. Those stored contacts count toward subsequent capacity checks.

Plan edits affect future assignments/purchases. Assigned plans keep their saved limits. Existing assigned records remain version 1 with their legacy omitted-feature behavior until replaced through assignment or renewal; no existing customer entitlements are silently rewritten by the migration.

## Extend an assigned user subscription

Use the `user_plans.id` from the subscription list, **not** `subscription_plans.id` or the user ID:

```http
POST /v1/admin/subscription/user-plans/<user_plan_id>/extend
Authorization: Bearer <admin_token>
Content-Type: application/json
```

```json
{
  "days": 30,
  "expected_end_date": "2026-10-23T12:00:00.000Z",
  "reason": "Customer support extension"
}
```

`days` is required: an integer from **5 to 30**. Each assigned `user_plans` record can receive **at most 30 extension days in total**, including earlier recorded extensions. `expected_end_date` is required: copy the current row's full UTC `end_date` timestamp. `reason` is optional, with 1–500 characters when supplied. Never send company/user IDs, a calculated new end date, fee, extension counters, price, or limits in this body. Authenticated company admins can extend only their own company's users; superadmins can extend users across companies through the same endpoint.

The first **10 cumulative extension days** are free. The extension that takes the total above 10 days applies the **current superadmin monthly platform fee once**, initially INR 100 / 10000 paise, from the target company's wallet to the platform wallet. Later extensions of that same assignment, up to 30 days total, do not charge it again. Splitting requests into 5-day grants does not bypass the threshold or cap. Monthly pricing is used for this up-to-30-day grant even if the original plan is Free or Yearly. A configured zero monthly fee is recorded as an applied waiver; it is not charged later if pricing changes. Normal plan renewal/reassignment creates a new `user_plans` record with a fresh extension allowance.

Before opening the modal, fetch `GET /v1/admin/subscription/user-plans/<user_plan_id>/extension-policy` with the administrator token. Its `data` includes `min_days: 5`, `max_days: 30`, `free_days: 10`, `extension_days_used`, `extension_days_remaining`, `free_days_remaining`, `extension_fee_applied`, `extension_platform_fee_paise`, live `monthly_platform_fee_paise`, `max_request_days`, `can_extend`, and the current `expected_end_date`. Show the maximum as `max_request_days`, disable submission if `can_extend` is false, and offer 5/10-day quick choices when within the remaining allowance. Display the fee when `extension_days_used + selectedDays > 10 && !extension_fee_applied`. A successful POST rechecks the current monthly price; prices/waivers must never be supplied by the frontend.

An active, completed **current assigned** subscription can be extended, including a Free trial. The API adds days to its existing end date. If that date has passed, it adds days from the server's current time. Start date and billing cycle remain unchanged; duration is recalculated from the original start to the new expiry. Pending payments, cancelled/suspended plans, future plans and historical/replaced assignments return HTTP 409. Extending a plan does not change the user's account activation/suspension status. A manually suspended plan must be resumed separately before extension. Usage/limits are preserved, billing-period resets retain their original anchor, and purchased packs receive the same new expiry. A paid extension is not a subscription renewal or an upgrade to the plan's feature limits.

The October 23 example returns HTTP 200 with the new November 22 expiry:

```json
{
  "success": true,
  "message": "Subscription extended successfully",
  "data": {
    "id": "<user_plan_id>",
    "user_id": "<user_id>",
    "plan_name": "Pro",
    "billing_cycle": "Monthly",
    "days_added": 30,
    "previous_end_date": "2026-10-23T12:00:00.000Z",
    "extension_starts_at": "2026-10-23T12:00:00.000Z",
    "start_date": "2026-09-23T12:00:00.000Z",
    "end_date": "2026-11-22T12:00:00.000Z",
    "duration_days": 60,
    "active": true,
    "status": "COMPLETED",
    "currency": "INR",
    "extension_days_used": 30,
    "extension_days_remaining": 0,
    "extension_fee_paise": 10000,
    "extension_platform_fee_paise": 10000
  }
}
```

For the Extend modal, retain the row's original `end_date` while it is open. Preview `max(Date.now(), Date.parse(row.end_date)) + days * 86400000`, disable Extend while submitting, and use the API's `data.end_date` as the final date. On success, update that row and refetch the subscription list, that user's entitlements, and the extension policy; refresh the company wallet balance when `extension_fee_paise > 0`. Existing user-plan endpoints read the updated row directly. Do not edit the subscription catalog definition.

Two requests using the same `expected_end_date` can apply at most one extension and fee. A duplicate/retry or stale form receives HTTP 409 with details code `PLAN_EXTENSION_CONFLICT` and `current_end_date`. Exceeding the cumulative cap returns HTTP 409 / `PLAN_EXTENSION_CAP_REACHED`, including remaining days. Invalid day counts return HTTP 400 / `INVALID_EXTENSION_DAYS`; insufficient wallet balance returns HTTP 400 / `INSUFFICIENT_COMPANY_WALLET_BALANCE` with required/available paise. Refresh the row to reconcile a lost response. Only replace the expected timestamp after the admin deliberately requests another extension; never automatically retry with the new timestamp. HTTP 403 indicates an unauthorized role, and 404 an unavailable or foreign-company plan. Dates, pack expiry, extension counters, both wallets, debit/credit ledger records and activity audit commit together; any failure rolls everything back.

Migration `20261020000002_subscription_extension_policy.ts` adds `user_plans.extension_days` and nullable `extension_platform_fee_paise`. NULL means no threshold fee has been applied; zero means an applied waiver. It counts identifiable historical manual extensions from their activity audits, without altering expiry dates or charging past fees. Existing assignments that already received 30 or more days cannot receive additional extensions; renew/reassign instead. Apply this migration before deploying the updated extension API. The ledger uses `reference_type: "subscription_extension"` with `reference_id` set to the assigned user-plan UUID. Rollback refuses to remove tracking after the new policy has been used.

## Fixed trial on admin registration

New company/admin registration creates the company's default catalog **and** activates only a matching Free `user_plans` snapshot in the same transaction. It sets `users.assigned_plan` to the active Free snapshot ID. The default is 10 days; the only allowed choices are 3, 7, and 10. Trial activation charges no wallet fee.

| Default catalog plan | Price (INR) | Billing | Catalog `active` |
| --- | --- | --- | --- |
| Free | 0 | Free / chosen trial duration | `true` |
| Basic | 99 | Monthly | `false` |
| Pro | 200 | Monthly | `false` |
| Enterprise | 999 | Monthly | `false` |

The three paid definitions use the agreed feature limits and marketing text in `src/app/utils/defaultSubscriptionPlans.ts`. Basic includes 2 team seats, 5,000 contacts, 20 campaigns per month, 1 WABA number, 2 chatbots, 1 AI assistant and disabled developer API access. Pro includes 2 seats, 20,000 contacts, unlimited campaigns, 3 WABA numbers, 10 chatbots, unlimited AI assistants and enabled developer API access. Enterprise includes 10 seats, 100,000 contacts, unlimited campaigns, 10 WABA numbers, 50 chatbots, unlimited AI assistants and enabled developer API access. Developer API request quotas/access enforcement remain separate work; these are catalog entitlement values, not newly enforced API limits.

Do not submit a `plans` array during registration: defaults are server-controlled. Basic/Pro/Enterprise are saved for later editing/publication, with no paid `user_plans`, checkout orders, wallet debits or automatic paid activation. Fetch `GET /v1/admin/subscription/plan` without `active=true` to see all four definitions. Publish a paid definition with `PUT /v1/admin/subscription/plan/:id` and `{ "active": true }` before it can be assigned/purchased. Prices and feature limits remain editable through the existing plan APIs.

Company catalog initialization is serialized in PostgreSQL. Adding another administrator reuses any existing company-owned monthly Basic/Pro/Enterprise definition without changing its owner, price, features or `active` setting. The established per-admin trial policy remains in place. Existing companies/plans are not backfilled or repriced by this change, and no yearly defaults are created automatically.

```http
POST /v1/auth/register-company
Content-Type: application/json
```

```json
{
  "name": "Example Company",
  "email": "owner@example.com",
  "trial_days": 10,
  "user": {
    "name": "Company Admin",
    "email": "admin@example.com",
    "password": "ChooseYourOwnStrongPassword123!"
  }
}
```

The same optional `trial_days` field is accepted by company onboarding through `/v1/admin/companies`, superadmin company creation, and `/v1/auth/create-admin` (superadmin-only, `role: "admin"`, company required). Omit it to use 10 days. A superadmin account itself does not receive a company trial. Ordinary end-user/team-member registration does not start an additional admin trial.

All Free plans use these platform-defined limits: TeamInvite 2, Contact 500, Campaign 2, WabaNumber 1, Chatbot 2, and AiAssistant 1. Call `GET /v1/admin/subscription/trial-policy` with an authenticated token for `features_locked: true`, `allowed_trial_days`, the default duration, and the feature map to render read-only limit inputs.

When creating a Free plan through `POST /plan`, `features` can be omitted; the server supplies the fixed map. If a create/update includes `features`, it must match the whole fixed map. Changed, removed, disabled, additional, resettable, or unlimited features are rejected. A Free plan cannot be converted to paid or deleted through subscription management; create a separate paid plan to upgrade. Paid plans continue supporting configurable feature maps.

Admins may update a company-owned Free trial definition with `PUT /v1/admin/subscription/plan/:id` and `{ "trial_days": 7 }`. This changes **future activations**, not the dates or usage of an already-running trial. Every activation path checks trial history so manual reassignment cannot restart an expired trial. Existing catalogue Free plans receive the fixed policy when newly assigned, even if their legacy feature JSON specifies unlimited limits. Existing active trial snapshots are not rewritten by this code change.

Registration responses preserve `freePlan` (the Free definition) and its nested `user_plan` (the active snapshot), and additionally expose `freePlan.subscription_plans` with the four catalog definitions and their saved IDs. The returned admin's `assigned_plan` is the Free snapshot ID, not the definition ID. Registration rolls back if any default creation, trial assignment, or activity logging fails. Apply `20261019000007_register_developer_api_feature.ts` alongside the existing trial-day, marketing-feature and entitlement migrations; it registers the developer API catalog key on fresh installations while preserving existing superadmin settings. It does not add enforcement or rewrite customer plans.

## Dynamic form

`GET /features` returns stable keys, labels, descriptions, `kind`, `active`, and `addon_allowed`. Build the feature rows in the screenshot from this response. Show an Include toggle, an Unlimited toggle, and a non-negative integer input. Omit inactive features and submit disabled rows explicitly or omit them.

The screenshot's “Plan Features” text list is submitted as `marketing_features`, an optional array of up to 100 non-empty strings (250 characters each). This display text appears in plan create/list/detail/update responses and does not change entitlements. On create it defaults to `[]`. On update, omit it to preserve the existing list or send `[]` to clear the list. Use `POST /plan` to create and `PUT /plan/:id` to update. Apply `20261019000002_subscription_marketing_features.ts` before sending this field.

`GET /entitlements` returns the authenticated owner's current plan, dates, and per-feature `base_limit`, `addon_limit`, `effective_limit`, `used`, and `remaining`. Unlimited effective limits/remaining values are `null`. A company administrator can use `GET /entitlements?user_id=<user-uuid>` for a user in the same company. The response's `user_plan_id` is required for an add-on purchase, preventing a stale screen from purchasing against a replacement plan.

## Create a team-member add-on

As **superadmin**, call `POST /addons`:

```json
{
  "name": "Extra team member",
  "feature_key": "TeamInvite",
  "units": 1,
  "price_paise": 5000
}
```

This example price is INR 50 per pack; choose the actual platform price. Prices are integer paise, and `units` is how much capacity one pack adds. Return the add-on UUID to the UI. `GET /addons` lists available packs. `DELETE /addons/:id` disables a pack for future purchases without changing existing purchases. Create a new pack to introduce a new price.

As **company administrator**, call `POST /addon-purchases` with `Idempotency-Key: <new-unique-key>`:

```json
{
  "user_id": "00000000-0000-4000-8000-000000000001",
  "user_plan_id": "00000000-0000-4000-8000-000000000002",
  "addon_id": "00000000-0000-4000-8000-000000000003",
  "quantity": 3
}
```

Replace these example UUIDs with saved records. The server computes:

```text
Extra capacity = pack units × quantity = 1 × 3 = 3
Effective team limit = base 2 + extra 3 = 5
Wallet charge = pack price × quantity = INR 50 × 3 = INR 150
```

The company debit, platform credit, paired ledger entries, purchase snapshot, audit entry, and capacity update commit together. Insufficient funds or a database failure rolls everything back. Retrying the same key and body returns the original purchase without charging again, even if the catalog price later changes. Reusing a key with a different purchase is rejected. The server rejects client-supplied prices, foreign users, inactive/expired/replaced plans, Free plans, disabled features, and already-unlimited features.

An add-on is a **single charge for the remaining current plan**, expires with that plan, and does not transfer to an upgrade or renewal. There is no automatic renewal, proration, or automatic refund. Show the total price and expiry date before submitting the purchase. Catalog prices should account for this rule; monthly/yearly plans can use different named packs if desired, but current packs are not restricted by billing cycle.

## Add future features

As **superadmin**, `POST /features`:

```json
{
  "key": "Export",
  "label": "Exports",
  "description": "Exports created in the billing period",
  "kind": "usage",
  "addon_allowed": true
}
```

The new key can immediately appear in the dynamic plan form and add-on catalog without new database columns. Enforcement still needs a hook in the feature's server operation:

```ts
await planUsageService.run(ownerId, 'Export', async trx => {
  return exportModel.create(data, trx);
});
```

Write the resource in the supplied transaction. For a new capacity feature, also add its resource-count query to `currentCapacity` so deleting resources and renewing plans preserve correct availability. Registering a key alone does not implement its product behavior. External side effects should use a persisted job/outbox rather than run inside the database transaction.

## Feature limits and import warnings (admin frontend)

Contact, campaign, chatbot, AI assistant, and team-invite creation use the account owner's allowance, including purchased add-ons. A full quota returns HTTP **403**, with structured details under `error`:

```json
{
  "success": false,
  "message": "Contact plan limit reached",
  "error": {
    "code": "PLAN_LIMIT_EXCEEDED",
    "feature": "Contact",
    "limit": 3000,
    "used": 3000,
    "requested": 1,
    "remaining": 0,
    "required_action": "UPGRADE_PLAN_OR_BUY_ADDON"
  }
}
```

Call `POST /v1/admin/contacts/import/preview` with bearer authentication and **multipart/form-data**. Let the browser set the multipart content type and boundary:

```js
const form = new FormData();
form.append('file', selectedFile);
form.append('phone_number_id', selectedPhoneId); // Local UUID or Meta phone ID
form.append('phone_column', 'Phone'); // Exact header; optional if detected
form.append('country_code', '91'); // Optional default for local numbers
const response = await fetch(`${API_BASE}/v1/admin/contacts/import/preview`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
});
const body = await response.json();
if (!response.ok) throw new Error(body.message);
const quota = body.data.subscription;
setImportDisabled(quota?.can_import !== true);
setImportWarning(quota?.can_import ? '' : quota?.message);
```

Preview stays HTTP **200** when the file exceeds capacity. Existing samples, column information, and validation counts remain in `data`. The new `data.subscription` for **5,000 new contacts and 3,000 remaining slots** is:

```json
{
  "checked": true,
  "feature": "Contact",
  "limit": 3000,
  "used": 0,
  "remaining": 3000,
  "unique_contacts": 5000,
  "duplicate_rows": 0,
  "existing_contacts": 0,
  "new_contacts": 5000,
  "excess_contacts": 2000,
  "can_import": false,
  "code": "CONTACT_IMPORT_LIMIT_EXCEEDED",
  "message": "This file would add 5000 new contacts, but your plan has room for 3000. Remove 2000 new contacts or increase your contact allowance before importing.",
  "required_action": "REDUCE_FILE_OR_BUY_ADDON"
}
```

`remaining` subtracts contacts already stored across the owner's account. `limit` includes add-ons. Unlimited plans return `limit: null` and `remaining: null`. Duplicate rows and existing contacts for the **same owner, company, and selected number** consume no extra slots. Contacts stored for another number count as new identities for this import. Use identical column mappings and country code in preview and import. Recheck after changing the file, sender, country, or mappings, and after buying an add-on.

Without `phone_number_id`, the raw preview still works but `subscription.checked` and `subscription.can_import` are false with code `PHONE_NUMBER_REQUIRED`. An unavailable Contact entitlement produces a blocked preview with code `PLAN_UNAVAILABLE`.

Once allowed, call `POST /v1/admin/contacts/import` with the same multipart fields plus `list_name`. Success still returns **202** and a job ID. An oversized import returns **403** with `error` containing the assessment above, before any job or contacts are created. It does not silently import a subset. The worker rechecks capacity after queue wait, and each new contact retains its transaction check. Preview does not reserve capacity: refresh entitlements and display the error message on a later 403. Poll the job's `status_url`; capacity changes before execution can fail the queued job with an explanatory `error_message`.

## WABA inventory and activation

`POST /v1/admin/waba/:wabaId/sync` saves new Meta numbers **only within the remaining allowance**. Remaining capacity is base `limits.WabaNumber.limit` plus `addon_limit`, minus the live active, non-deleted number count across the user's WABAs. Historical numeric-string add-on values such as `"2"` are normalized when read; malformed add-on values do not grant capacity. With one remaining slot and two new Meta numbers, one is saved and the other is skipped, without inserting an inactive overflow row. The response includes `phone_numbers`, `active_count`, `inactive_count`, `skipped_count`, `skipped_phone_numbers` (ID and reason), and `remaining_slots` (null for unlimited). Without a usable entitlement, new numbers are skipped with reason `PLAN_UNAVAILABLE`. An exhausted valid plan gives `PLAN_LIMIT_EXCEEDED`. Onboarding exposes the same report in `data.data.phone_number_sync` and retains its `phoneNumbers` array; the older sync endpoint retains its array response. Direct single-number creation returns 403 at capacity.

Use **`active`** for the enabled badge and sender picker. `status` keeps its existing meaning, and `code_verification_status` remains Meta's verification state. Inactive numbers remain visible in settings and cannot send outbound messages, create campaigns, or run chatbot/AI flows. Repeated syncs preserve inactive numbers. After a downgrade, a sync keeps the oldest allowed active numbers and deactivates overflow without deleting number records or contacts. Running campaigns observe deactivation between batches; in-flight sends can finish.

Enable or disable using the **local UUID**:

```http
PUT /v1/admin/waba/phone-numbers/{local-phone-uuid}
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "active": true }
```

Send `{ "active": false }` to disable and free capacity. Enabling another number at capacity returns **403** `PLAN_LIMIT_EXCEEDED` for `WabaNumber`. Buy an add-on or disable another number, then explicitly enable the desired number. Buying an add-on does not automatically reactivate saved numbers. Sending with an inactive number returns **403** `WABA_NUMBER_INACTIVE` with `required_action: "ACTIVATE_WABA_NUMBER"`.

## Existing subscription and user-plan backfill

`20261019000005_backfill_plan_entitlements.ts` upgrades existing records; it does not assign or purchase a new plan. The migration was applied to the configured development database on 2026-10-19 (batch 24): **41 subscription plans and 138 user-plan snapshots were updated**. The other two subscription plans and one user-plan snapshot were already correct. All **43 subscription plans and 139 user-plan snapshots** now contain `TeamInvite`, `Contact`, `Campaign`, `WabaNumber`, `Chatbot`, and `AiAssistant`.

Legacy names such as `contacts`, `campaigns`, `team_invites`, and `ai_assistant` become the canonical keys above. `-1`, `Unlimited`, and `unlimited` become JSON `null`. The API also accepts those historical key aliases and rejects duplicate definitions for one feature. Existing custom features remain in the plan. The existing `developer_api` feature is registered for catalog editing; this change does not introduce an enforcement hook or paid add-on for that feature.

For paid plans, existing explicit limits remain. Missing features default to two team members, three WABA numbers, ten chatbots, and unlimited AI assistants. An omitted legacy Contact/Campaign allowance remains explicitly unlimited. Free catalog plans use the fixed platform trial policy (2 members, 500 contacts, 2 campaigns, 1 WABA number, 2 chatbots, 1 assistant); configured 3/7/10-day durations remain unchanged, and a missing catalog trial duration defaults to ten days.

Existing user snapshots are handled separately from the catalog: explicit unlimited allowances remain unlimited until that plan ends. Missing trial capacity defaults to the trial allowance. Current capacity and campaign usage are reconciled, without resetting consumed campaign quota or removing purchased add-on units. When a current legacy user already exceeds a finite allowance, their snapshot is raised to cover the existing usage. `legacy_base_limit` and `grandfathered_at` explain that exception. This protected **21 Contact, 2 WABA, and 2 Campaign allowances** during deployment. No contacts or phone numbers were deleted or deactivated. An allowance already filled by existing usage requires an add-on/upgrade for additional capacity. Renewals and new assignments use the catalog; current-plan grandfathering does not automatically carry forward.

Legacy snapshots become entitlement version 2 so capacity checks count saved resources. Other omitted registered features that were implicitly unlimited under version 1 remain explicitly unlimited. Version 2 features that were already disabled or omitted retain that denial. Plan prices, billing cycles, assignments, payment status, wallet balances, start/end dates, and phone activation states are unchanged. Cancelled, pending, and expired snapshots are normalized without assigning current resource usage to their history.

Read-only preview and local backup:

```powershell
node scripts/preview-plan-entitlement-backfill.cjs
```

It writes before/after JSON under `backups/plan-entitlement-backfill/`. A second preview after deployment reports zero remaining changes. The database table `plan_entitlement_backfill_audit` also stores the exact prior/applied values for 180 records (41 catalog plans, 138 snapshots, 1 feature definition). The migration's down operation restores originals only while their entitlement fields still match the applied state; it refuses to overwrite later usage, edits, or add-on purchases. Test that rollback in a transaction first when needed.

The build and 96 targeted/regression tests passed. A PostgreSQL transaction verified the upgrade, feature-registry validation, unchanged prices/dates/statuses, idempotence, exact rollback restoration, and refusal to overwrite newer usage. All verification changes were rolled back before the actual migration was applied. A post-apply check validated 474 current entitlements and confirmed unchanged wallets, ledger counts, assignments, and number activation states.

## Rollout and verification

Apply `20261019000001_dynamic_plan_addons.ts`, `20261019000003_platform_pricing.ts`, and `20261019000004_phone_number_entitlements.ts` before running this API version. The first creates `plan_features`, `plan_addons`, and `user_plan_addons`, and adds `entitlement_version` and `usage_periods` to `user_plans`. The pricing migration creates the global fee policy and pricing audit table, adds the fee quote column, and preserves legacy fees for pending orders. The phone-number migration adds `active`, `inactive_reason`, and an index for counting active numbers; existing numbers marked `status: inactive` remain inactive. Feature definitions are seeded; priced add-on packs are created through the superadmin API.

```powershell
npm run knex -- migrate:up 20261019000001_dynamic_plan_addons.ts
npm run knex -- migrate:up 20261019000003_platform_pricing.ts
npm run knex -- migrate:up 20261019000004_phone_number_entitlements.ts
npm run knex -- migrate:up 20261019000005_backfill_plan_entitlements.ts
npm run build
node --test tests/platform-pricing.test.cjs tests/dynamic-plan-addons.test.cjs tests/plan-usage.test.cjs tests/plan-assignment.test.cjs tests/payment-plan.test.cjs tests/subscription-duration.test.cjs tests/waba-sync.test.cjs
node --test tests/feature-limit-middleware.test.cjs tests/contact-import-limits.test.cjs tests/contact-import-worker.test.cjs
node --test tests/legacy-plan-backfill.test.cjs
```

On 2026-10-19, the plan/add-on migration was applied to the configured development database using `npm run knex -- migrate:up 20261019000001_dynamic_plan_addons.ts`. Its tables, columns, and eight seeded feature definitions were verified. Older contact migrations remain pending because existing contact identities contain duplicates and invalid phone data; they must be reviewed before `migrate:latest` can finish. The local report is in `backups/migration-audit-2026-10-19/`.

The phone-number migration was applied to the configured development database on 2026-10-19 (batch 23), and both new columns were verified. The build and 215 targeted/regression tests passed. A PostgreSQL transaction also verified overflow sync, activation rejection at capacity, disabling to free a slot, repeat-sync behavior, active-only usage, and the 5,000-versus-3,000 import assessment; all verification data changes were rolled back. A broader campaign-worker suite still has nine failures, reproduced against the original committed code, outside these changes.

Unit tests simulate transaction serialization/rollback; they do not replace a PostgreSQL integration test in the deployment environment. The dashboard shown in the screenshots is not present in this API repository; connect its form to these endpoints.
