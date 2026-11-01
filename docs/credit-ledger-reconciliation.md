# Credit ledger reconciliation — 28 October 2026

Superadmin grants increase the recipient company's wallet and create one company credit entry. They do not debit the superadmin wallet or count as platform revenue. Subscription commissions, subscription extension charges, and add-on purchases debit the company wallet and credit the superadmin user wallet.

The superadmin user and `soft7admin@gmail.com` originally belonged to the same company. Their ledgers remain separated by wallet owner, including preserved historical transactions. Company histories exclude entries owned by a superadmin user; superadmin fee history includes only credit entries owned by that user with reference types `subscription_commission`, `subscription_extension`, or `plan_addon`.

## Dedicated platform company

At the user's subsequent request, the database separation was applied on 28 October 2026 after a successful rehearsal that was rolled back.

| Account | Company ID |
| --- | --- |
| `soft7.in@gmail.com` / Soft7 Platform | `1056a749-ea3d-4c1d-9798-a6882d9997f5` |
| `soft7admin@gmail.com` / existing Soft7 Tech company | `ae815512-cf4b-4e7e-8472-16d3c2d4bb18` |

Only the superadmin's `users.company_id` was updated. Its role, user ID, credentials, and INR 148,294 user-wallet balance were preserved. A new platform company and one audit entry were inserted. The new company wallet starts at zero; existing funds were not duplicated into it. The original company's INR 1,560.04 balance was preserved.

Existing contacts, transactions, login-domain records, and other business records retain their original company IDs. New platform-company settings explicitly identify the migrated user, its previous company, and its permitted existing login-domain IDs. The rebuilt API uses those settings only for compatible reads: existing login domains, owner-scoped contact listings, historical company/user routes, and profile counts. Normal company users cannot inherit this legacy scope. Existing writes remain scoped to their intended company; historical rows are not moved automatically.

Post-change verification confirmed all 7,906 existing superadmin contacts and 122 platform-fee entries remain accessible. Recorded platform fees were INR 64,960 at that verification. The original company's history contained 88 entries. These differ from the initial audit below because legitimate transactions occurred between the audit and separation.

The operation checked preservation fingerprints across 61 table scopes: all existing company/user/credit-transaction/domain rows, and the superadmin's existing business records and relevant original-company records. The backup is `backups/platform-company-separation/2026-10-28T06-31-08-696Z-apply.json`; its `-result.json` contains the safe operation summary. Backups are excluded from Git.

Deploy/restart the rebuilt API to activate login-domain compatibility and historical contact reads. Existing JWTs derive the current company ID from the database, so their old company claim does not override the new company link.

## Initial API separation

The initial API-only separation used read-only queries and did not change company links. The later company separation above updates only the superadmin company link and preserves the existing data. These API routes continue to separate platform and company wallets.

| Purpose | GET route | Scope |
| --- | --- | --- |
| Superadmin balance and fee total | `/v1/super-admin/wallet` | Authenticated superadmin user ID |
| Superadmin fee history | `/v1/super-admin/wallet/transactions` | Authenticated superadmin user ID |
| Logged-in company balance | `/v1/admin/credits/balance` | Company ID for company/admin users |
| Logged-in company history | `/v1/admin/credits/transactions` | Company ID, excluding superadmin user-wallet entries |
| Inspect a company's history as superadmin | `/v1/super-admin/companies/:companyId/credits` | Selected company ID, excluding superadmin user-wallet entries |

Both new routes require JWT authentication and the existing live superadmin authorization check. The history endpoint accepts `page`, `limit` (at most 100), `type`, `reference_type`, `from`, and `to` (exclusive). It rejects caller-supplied `user_id` or `company_id` filters. Example: `/v1/super-admin/wallet/transactions?page=1&limit=25&reference_type=subscription_commission`.

Responses identify the wallet with `wallet_scope: "platform"` and `wallet_user_id`. Use this identity in the superadmin UI; a returned historical transaction's `company_id` remains its original stored value. Wallet `balance` includes the preserved opening balance and older receipts, while `platform_fee_total` includes only recorded platform fees. History pagination uses the same ownership scope as the row query. Legacy superadmin wallet/history endpoints remain compatible, including `/v1/admin/credits/superadmin/transaction`.

## Database findings and applied correction

The connected database contained 15 manual grants incorrectly labeled as debits. Each had a positive amount, no user wallet owner, a superadmin actor, and a stored balance increase exactly matching its amount. These entries were relabeled as credits. Original types and correction timestamps are retained in `meta_data.manual_topup_type_repair_20261028`; amounts and balances were preserved.

Five corrected entries belong to `soft7admin@gmail.com`, totaling INR 21,150.02. Including its existing INR 10,000 grant, recorded company top-ups total INR 31,150.02. Its current wallet balance is INR 2,560.04, matching the latest recorded closing balance.

| Recorded platform fees | Company debits | Superadmin credits |
| --- | ---: | ---: |
| Subscription commissions | INR 63,400.00 | INR 63,400.00 |
| Subscription extensions | INR 100.00 | INR 100.00 |
| Add-ons | INR 460.00 | INR 460.00 |
| Total | INR 63,960.00 | INR 63,960.00 |

The superadmin wallet's INR 147,294 balance consists of INR 43,338 in opening balance, INR 39,996 in older subscription receipts, and INR 63,960 in recorded platform fees. These are separate accounting categories. The subscription dashboard's superadmin `total_revenue` now uses recorded platform fees; company statistics retain active catalog value and expose `revenue_basis`. Payment receipts remain a separate field in the operations revenue report.

## Remaining historical discrepancies

34 older entries have balance snapshots inconsistent with their signed transaction amounts; 23 belong to the company shared by `soft7admin@gmail.com`. The company's recorded net movement is INR -18,089.98, while its current balance is INR 2,560.04, a difference of INR 20,650.02. The existing ledger cannot establish whether that difference represents an opening balance, missing entries, or historical balance changes. No synthetic income, adjustment transactions, or guessed wallet balances were written. Reconstructing those snapshots requires older backups or another authoritative record of wallet changes.

The full pre-repair snapshot is stored locally at `backups/credit-ledger/2026-10-28T05-53-04-387Z-repair.json`. The corresponding `-repair-report.json` lists every remaining inconsistent transaction ID. Backups are excluded from Git.

## Operation and validation

`node scripts/separate-platform-company.cjs` previews a dedicated platform organization and writes a local backup. `--rehearse --company-id <UUID>` exercises creation, relinking, audit, and preservation checks, then rolls the database transaction back. `--apply --company-id <UUID>` commits the same operation. Repeating the operation recognizes the existing platform organization and does not create another one. The script refuses unexpected account roles, company assignments, ID/email collisions, and unreviewed custom user/company triggers.

The separation build and 52 targeted tests passed. Read-only checks against the connected database verified the new and preserved company links, global superadmin role, legacy login domains, contact totals, wallet/history reads, and stale-token handling.

`node scripts/audit-credit-ledger.cjs` produces a read-only audit and local snapshot. Adding `--repair-manual` applies only the narrowly matched type correction in a database transaction after writing a backup. The new migration applies the same correction idempotently and supports rollback. The repair script already applied this correction to the connected database; running the migration later will find no remaining matching rows.

`CREDIT_LEDGER_DATABASE_TEST=true node --test tests/credit-ledger.test.cjs` checks actual PostgreSQL behavior in an isolated schema that is rolled back, including wallet separation, grant rollback, fee reporting, and reversible repair. Production API changes require deploying or restarting the rebuilt API.
