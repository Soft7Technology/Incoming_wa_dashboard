# Dynamic plans and wallet add-ons

The platform superadmin owns the feature/add-on catalog. Company administrators create plans and assign them to users using the existing assignment endpoints. A company administrator buys extra units for a specific user's current paid plan from the company wallet. The platform wallet receives the same amount.

All endpoints below use the existing JWT authentication and start with `/v1/admin/subscription`.

## Create the requested plan

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
| Omitted feature | Disabled for newly assigned plans |

The optional `enabled` flag defaults to `true`. Updating `features` replaces the whole feature map; omitting `features` preserves it. Include additional features such as `Tag` if the plan should permit them.

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

## Fixed trial on admin registration

New company/admin registration creates a company-owned Free trial definition **and** activates a matching `user_plans` snapshot in the same transaction. It sets `users.assigned_plan` to the active snapshot ID. The default is 10 days; the only allowed choices are 3, 7, and 10. Trial activation charges no wallet fee.

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

Registration responses contain `freePlan` (the definition) with a nested `user_plan` (the active snapshot). The returned admin's `assigned_plan` is the snapshot ID, not the definition ID. Registration rolls back if trial creation, assignment, or activity logging fails. No additional database migration is required beyond the existing trial-day and entitlement columns.

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

## Rollout and verification

Apply `20261019000001_dynamic_plan_addons.ts` before running this API version. It creates `plan_features`, `plan_addons`, and `user_plan_addons`, and adds `entitlement_version` and `usage_periods` to `user_plans`. It seeds feature definitions but no priced add-ons and no customer plan changes.

```powershell
npm run migrate:latest
npm run build
node --test tests/dynamic-plan-addons.test.cjs tests/plan-usage.test.cjs tests/plan-assignment.test.cjs tests/payment-plan.test.cjs tests/subscription-duration.test.cjs tests/waba-sync.test.cjs
```

On 2026-10-19, the plan/add-on migration was applied to the configured development database using `npm run knex -- migrate:up 20261019000001_dynamic_plan_addons.ts`. Its tables, columns, and eight seeded feature definitions were verified. Older contact migrations remain pending because existing contact identities contain duplicates and invalid phone data; they must be reviewed before `migrate:latest` can finish. The local report is in `backups/migration-audit-2026-10-19/`.

Unit tests simulate transaction serialization/rollback; they do not replace a PostgreSQL integration test in the deployment environment. The dashboard shown in the screenshots is not present in this API repository; connect its form to these endpoints.
