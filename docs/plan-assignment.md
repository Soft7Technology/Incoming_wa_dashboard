# User plan assignment

`PUT /companies/user/:userId` takes `assigned_plan` as a **subscription_plans.id**. The response user stores **user_plans.id** in `assigned_plan`. These IDs have different meanings.

The caller must be a superadmin or an admin/company account in the target user's company. Company-owned plans must belong to that company; global plans have a null company_id.

Assignment reads the active user plan by user_id, locks affected rows, and commits the following in one transaction:

- Transfer the platform fee and write matching wallet ledger entries.
- Deactivate the old plan, preserving its original dates for history.
- Insert an independent user_plans snapshot (name, features, price, dates, add-ons, company_id).
- Set users.assigned_plan to the new snapshot ID and write the activity record.

Free plans last 3, 7, or 10 complete days. Monthly/Yearly plans use UTC calendar months/years, clamped at month end. A Jan 31 monthly activation ends Feb 28 (Feb 29 in leap years). duration_days is the ceiling of the actual elapsed period in days.

Paid-to-paid changes preserve the exact unused time, without rounding up or price conversion. Free time is not carried to paid plans. An expired plan may be renewed, including the same plan. An unexpired identical plan is rejected to avoid charging twice. Cancel an active paid plan before assigning Free. Admin assignment can grant a Free plan; self-service trial activation remains limited to one historical trial.

The company wallet pays only the existing platform fee: 100 Monthly or 1000 Yearly. The plan's retail price is not debited by this endpoint. Paid assignments require a company wallet; a missing company no longer causes an unfunded credit to the superadmin. Free assignments do not touch wallets.

Changing or deleting plan definitions affects future assignments only. User plans have no `subscription_id` or foreign key to the catalog; existing active, expired, and pending snapshots keep their prices, dates, limits, usage, and add-ons. Pending payments can finish from their saved snapshot after the catalog plan is deleted. Duplicate active assignments are detected by comparing the saved name, price, billing cycle, base limits, and add-on selections. Catalog IDs may still appear in request payloads and audit history to identify what was originally selected; they are not stored on user_plans. New assignments reset Contact/Campaign/Chatbot creation usage, matching prior behavior. TeamInvite usage preserves current team seats (pending plus accepted invitations).

## Deployment and verification

Apply `20261021000001_independent_user_plans.ts` together with the updated API and workers. Stop old API/worker processes before dropping the column, since old code still writes it. From the deployed checkout, run `npm run migrate:latest`, then start the updated build. The migration drops only `user_plans.subscription_id` and its foreign key; it preserves every assigned snapshot and `users.assigned_plan`. Rollback restores a nullable column with `ON DELETE SET NULL`; removed source IDs are not reconstructed.

The migration regression test uses a temporary PostgreSQL schema in a transaction that is rolled back. Set `USER_PLAN_INDEPENDENCE_DATABASE_TEST=true` and run `node --test tests/user-plan-independence.test.cjs` to verify catalog deletion preserves active, historical and pending plans, user assignment pointers, and payment-order links.

Apply the trial_days migration and the user-plan index migration using `npm.cmd run migrate:latest`. The latter enforces one active user plan and adds a user/billing-cycle index for trial eligibility. If historical duplicate active plans exist, migration fails safely. Inspect and reconcile those records deliberately before rerunning:

```sql
SELECT user_id, count(*) FROM user_plans WHERE active = true GROUP BY user_id HAVING count(*) > 1;
```

Tests use an in-memory transaction harness for service behavior and rollback, plus date boundary tests. They do not prove PostgreSQL concurrency or production throughput. Run concurrent assignment and rollback integration tests against a disposable copy of the actual schema before deployment. The repository does not include the original subscription_plans/user_plans table migrations.

The superadmin wallet is shared and serializes paid fee transfers. At high write volume it may become a bottleneck; measure contention before introducing a ledger aggregation design. Other wallet-writing endpoints must also use atomic updates/row locks to prevent interference. Checkout tests verify that a saved pending purchase can activate after its catalog definition is removed, using a fake payment provider.


## Returned plan metadata and usage

User assignment responses, user detail/list responses, and company subscription lists expose `plan_name` and `duration_days`. The name is copied exactly from the selected company/global subscription plan; duration is a separate numeric field and is not appended to the name.

Feature keys are `Contact`, `Campaign`, `Chatbot`, and `TeamInvite`. For example, `features.TeamInvite = { "limit_type": "Seats", "limit_value": 5 }` sets a five-seat limit when the plan is assigned. Existing assigned plans retain their snapshot; editing a plan definition does not change them.

Manual/API contact creation and new contacts from imports, campaign creation, and chatbot creation increment only the current plan in the same database transaction as creation. Duplicate/failed creation does not increment it. Import updates to existing contacts do not consume additional quota. Deleting contacts, campaigns or chatbots does not refund cumulative creation usage. Automatic incoming-message contact capture remains outside this creation quota; it is not blocked by these changes.

`usage.TeamInvite` counts current `user_team` records with status `sent` or `accepted`, owned by `invite_sent_by`. Sending reserves a seat before email delivery; a caught delivery failure removes a pending reservation. Acceptance does not add a seat. Deletion frees a seat. Invite/delete/accept operations serialize on the owner row. A process crash between reservation and email completion may leave a pending invitation that requires removal/retry; a durable email outbox is not implemented here.

Explicit zero limits deny creation; null or absent feature limits retain legacy unlimited behavior. Team-member operations use the owner's plan. All writes lock owner then active plan to serialize quota consumption against assignment. Apply `20260923000003_backfill_team_seat_usage` to initialize existing active plans' team-seat counts. Other historical counters are not rewritten: previous code incremented old plans and omitted imports/chatbots, so historical totals cannot be reliably reconstructed from counters alone.

Transaction tests use a serialized in-memory harness; the schema-independence regression also runs against PostgreSQL in a temporary schema and rolls back all changes. No migration was applied to application tables, and no email was sent.
