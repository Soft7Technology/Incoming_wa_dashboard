# Company credits paid through Razorpay QR

Company administrators can purchase credits through a separate API. INR 1 buys 1 wallet credit, including paise precision: INR 150.25 adds 150.25 credits. The amount credited is the gross captured payment amount, without deducting gateway fees. Gateway charges remain a platform expense.

The configured platform `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are used. Customer-company gateway configurations are not used for credit purchases. Only live keys can grant real credits. No keys or webhook secrets are returned to the dashboard.

The supplied SOFT7 image was decoded and matched to the platform's existing active QR `qr_TtGljDzJjusNNA`. That is a shared multiple-use QR without a fixed amount. A payment to that shared image cannot safely identify its purchasing company automatically. The purchase API therefore creates a unique, single-use, fixed-amount QR in the **same Soft7 Razorpay account**. Its server-generated notes bind it to one credit purchase and one company. The original supplied image is retained as a reference asset; the dashboard must display each purchase's `qr_image_url` for payment.

## Dashboard flow

All company endpoints below use `Authorization: Bearer <company-admin-JWT>`. Roles `admin` and `company` are accepted. Normal team users and superadmins cannot use these routes to mint platform-wallet credits. Company and user IDs always come from authentication; do not send them in request bodies or query filters.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/admin/credits/topups/options` | Limits, readiness, instructions, and reference-image path |
| POST | `/v1/admin/credits/topups` | Reserve a credit purchase and generate its payment QR |
| GET | `/v1/admin/credits/topups` | List this company's purchases; supports `page` and `limit` |
| GET | `/v1/admin/credits/topups/:id` | Read saved status without calling Razorpay |
| POST | `/v1/admin/credits/topups/:id/verify` | Check Razorpay and apply captured payment exactly once |

1. On **Add credits**, fetch `/options` and let the administrator enter an amount.
2. Generate a fresh retry key for that purchase. Create a QR, for example for INR 1,000:

```http
POST /v1/admin/credits/topups
Authorization: Bearer <JWT>
Idempotency-Key: <unique-purchase-key>
Content-Type: application/json

{"amount_paise":100000}
```

3. Keep the returned purchase `id`. Show its `qr_image_url` and amount in the payment modal. The QR expires after 15 minutes. Do not use the shared reference QR for this automatic purchase.
4. When the payer clicks **I have paid / Confirm**, call:

```http
POST /v1/admin/credits/topups/<purchase-id>/verify
Authorization: Bearer <JWT>
Content-Type: application/json

{}
```

5. A click is only a request to verify. It is not proof of payment. Wait for `status: "credited"`, then refresh `/v1/admin/credits/balance` and `/v1/admin/credits/transactions`. For an unpaid purchase, `credits_added` remains zero. The frontend may retry verification about every five seconds while the modal is open; stop after success or an actionable error. With webhooks enabled, polling the read-only status endpoint is sufficient.

The routes return the normal `{success,message,data}` response wrapper. Purchase fields include `id`, `company_id`, `amount_paise`, `currency`, `status`, `qr_code_id`, `qr_image_url`, `payment_id`, `paid_amount_paise`, `refunded_amount_paise`, `credits_added`, `transaction_id`, and timestamps. `credits_added` is the net credit grant after verified refunds; it is not the entire company balance.

Amounts are integer paise from 100 through 100000000, corresponding to INR 1 through INR 1,000,000. Reusing an `Idempotency-Key` with the same request returns the existing purchase. Reusing it for a different amount fails. If QR creation times out, use the returned `topup_id` in error details and verify/recover that same purchase. The server searches Razorpay using its own purchase notes; it does not blindly create a second QR.

## Automatic Razorpay callbacks

Configure a webhook in the platform's **live Razorpay dashboard**:

```text
https://hostapi.soft7.in/v1/webhooks/razorpay/credits
```

Subscribe to `qr_code.credited` and `refund.processed`. Set its secret to the server's `RAZORPAY_WEBHOOK_SECRET`. Existing environment keys were found configured, but the webhook URL and event subscriptions must be configured in the Razorpay dashboard for unattended updates. The Confirm/verify API also works without that callback.

The callback is public because Razorpay cannot supply a user JWT. It authenticates the exact request bytes using HMAC-SHA256 and `X-Razorpay-Signature`. Never reconstruct the raw body from parsed JSON. Duplicate event IDs are recorded, and repeated browser/webhook confirmations share the same locked fulfillment path. Unsupported events and payments to unrelated/shared QR codes are ignored.

The backend independently fetches the purchase QR, its payments, and the selected payment from Razorpay. It verifies QR ownership notes, single-use/fixed-amount settings, captured payment status, amount, INR currency, and UPI method. Client-submitted payment IDs, screenshots, UTRs, amounts on confirmation, and webhook amounts cannot grant credits.

## Balances and history

The order lock, company balance update, company ledger entry, and activity record commit in one database transaction. Unique provider payment IDs, order receipt links, and a unique ledger index prevent repeated crediting. A late database/audit failure rolls back the balance and ledger together, and verifying the same payment can safely be retried.

Company history receives a credit with reference type `razorpay_topup`. No superadmin debit is created. The receipt is retained in `credit_topup_orders`; it is not added to platform-fee revenue or the superadmin fee wallet. Actual platform usage fees continue through the existing fee ledger.

Verified refunds subtract only the newly refunded amount using reference type `razorpay_topup_refund`. Repeated and out-of-order refund events cannot subtract it twice. A refund after credits have been spent can leave an outstanding negative company balance; this prevents retaining spendable credits for money that has been returned. A payment that was already refunded at first verification is recorded with the corresponding offset, so it cannot create usable refunded credits.

The original reference image is available at `/v1/webhooks/razorpay/credits/reference-qr` and is copied into the build. It has no payment-to-company ownership binding and is not the automatically credited checkout QR.

## Deployment and checks

The named migration `20261028000002_credit_topup_orders.ts` has been applied to the connected database as batch 37. It added `credit_topup_orders`, `credit_topup_webhook_events`, and a receipt uniqueness index. Before/after checks confirmed all existing company and user-wallet balances and transaction-history fingerprints were unchanged. The setup snapshot is `backups/credit-topup-setup/2026-10-28T09-19-22-952Z.json` with a corresponding `-result.json`. No live payment or top-up was created during setup.

Deploy/restart the rebuilt API, connect the dashboard button to the new routes, and configure the Razorpay callback for unattended fulfillment. Other databases need the named migration applied as part of deployment. Rollback refuses to delete purchase history once orders exist.

Tests cover captured versus unconfirmed payments, exact decimal credits, repeated verification, tenant isolation, mismatched amounts/currencies, captured/refunded states, cumulative refunds, ambiguous QR creation recovery, late audit rollback, competing browser/webhook confirmations, authentication, credential isolation, and exact raw-body signature verification. PostgreSQL tests use an isolated schema inside a rolled-back transaction; they never charge money or call the live Razorpay write API.

```powershell
$env:CREDIT_TOPUP_DATABASE_TEST='true'
node --test tests/credit-topup.test.cjs
npm run build
```

Provider references: [Razorpay QR creation](https://razorpay.com/docs/api/qr-codes/create/), [QR payments](https://razorpay.com/docs/api/qr-codes/fetch-payments/), [QR webhook events](https://razorpay.com/docs/webhooks/qr-codes), and [webhook signature validation](https://razorpay.com/docs/webhooks/validate-test/).
