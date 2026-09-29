# Company payment gateways

Base URL: `/v1/admin/payments`. All requests require `Authorization: Bearer <JWT>`.
The JWT company determines the merchant account; a payload `company_id` cannot select another company.
Company administrators (`admin`, `company`, `superadmin`) with a company context can configure gateways and create orders.
Other users can read/verify only their own orders. Administrators can read/verify orders within their company.

Orders with `subscription_plan_id` create a pending user plan at the saved catalogue price and activate it after verified live payment. Amount-only orders collect payments without granting subscriptions. This module does not credit wallets or issue refunds. Company-gateway subscriptions use company-owned plans; global platform plans continue to use their separate assignment flow.

## Setup

1. Generate a dedicated 32-byte encryption key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Set `PAYMENT_GATEWAY_ENCRYPTION_KEY=<64 hex characters>` in the API environment and restart it.
   Keep this key stable and backed up. Replacing it requires re-encrypting existing credentials first.
3. Run `npm.cmd run migrate:latest` (or `npm run migrate:latest` outside PowerShell).
4. Configure each company's gateway using that company's administrator JWT.

## Configure a gateway

`POST /v1/admin/payments/gateways` creates the first active configuration for the chosen mode and returns HTTP 201.
If that company already has an active gateway in the mode, POST returns HTTP 400 and preserves it.
Use `PUT /v1/admin/payments/gateways` with the same body to replace credentials or switch providers.
Both endpoints require a company administrator JWT and `Content-Type: application/json`.

```json
{
  "provider": "razorpay",
  "mode": "test",
  "display_name": "Your Company",
  "key_id": "rzp_test_YOUR_KEY",
  "key_secret": "YOUR_SECRET"
}
```

For Cashfree use `"provider": "cashfree"`, the Cashfree App ID as `key_id`, and its secret as `key_secret`.
Use the matching test or production credentials. Razorpay key prefixes are checked against the selected mode;
Cashfree uses separate sandbox and production API hosts. Saving credentials does not itself validate them with
the provider; creating a test order checks whether the test credentials work.

One gateway is active per company per mode. PUT deactivates the previous version; POST never replaces an active configuration.
Existing orders retain their original credentials for verification; revoking those keys at the gateway may
prevent verification. Secrets are encrypted and never returned by these endpoints.

- `GET /providers`: supported gateways and credential field labels for your settings UI.
- `GET /gateways`: active configuration metadata only.
- `DELETE /gateways/test` or `/gateways/live`: disable new orders in that mode.

## Create and complete a INR 1 sandbox payment

`POST /test-orders` with `Idempotency-Key: <unique value for this payment attempt>`:

```json
{ "customer_phone": "9999999999" }
```

The phone is required for Cashfree and optional for Razorpay. This endpoint always creates an INR 1 (100 paise)
test order; it rejects live mode and any other amount. It does not debit money by itself. The payer completes
the returned gateway checkout. Use the provider's test payment instruments in sandbox.

The response's `data.id` is the local UUID used with GET/verify. `data.provider_order_id` belongs to the gateway.
`data.checkout` contains the public Razorpay checkout options or Cashfree `payment_session_id`.

Use [payment-test.html](payment-test.html) from your frontend's allowed HTTP/HTTPS origin to create an order,
open checkout, and verify its status. The page accepts an administrator JWT and keeps it only in memory.
Select Test for sandbox or Live for a real payment, then enter the amount in paise. Inputs stay locked to the current attempt until you select New payment attempt. For Cashfree, register the frontend domain in your gateway dashboard as required.
Do not open it with a `file://` URL; serve it from an origin allowed by the API's CORS policy.

## Create a live order

Configure `mode: "live"` with production credentials, then `POST /orders` with a new `Idempotency-Key`:

```json
{
  "mode": "live",
  "amount_paise": 100,
  "customer_phone": "9999999999"
}
```

`amount_paise` is an integer, in INR subunits, from 100 to 100000000. Thus 100 is INR 1 and 10000 is INR 100.
The production merchant account must support the amount and payment method. A completed live checkout moves
real money; no automatic refund is performed. `display_name` is passed to checkout where supported; gateway
branding and merchant identity remain subject to gateway settings.

## Verify payment

After checkout, call `POST /orders/<local-id>/verify` with no body. This reads the order from the gateway using
the stored company's credentials and checks order identity, currency, amount and paid status. Client callbacks
are not accepted as proof. Razorpay must report the fully paid order (capture completed); Cashfree must report
`PAID`. Configure capture appropriately in the Razorpay dashboard.

`GET /orders/<local-id>` returns the last stored status; it does not contact the provider. Call verify again if
checkout has completed but the gateway still reports pending. `paid` records payment receipt, not refund or
settlement status. This version has no automatic webhook or background reconciliation; integrate verification
into checkout completion and your pending-order reconciliation process.

## Retries

Reuse the same `Idempotency-Key` and exact request body when retrying order creation. It is scoped by company
and requesting user. A conflicting request is rejected. Reusing a key returns the same local order; it does not
create a second gateway order. An in-flight request returns `creating`; fetch it again after the first finishes.

An upstream timeout or failure leaves `creation_unknown`, because the gateway might have accepted the order.
A crash can leave `creating`. Reconcile these in the provider dashboard before using a new key. The local UUID
is sent as Razorpay's receipt or Cashfree's order ID. Automatic retries of unknown Razorpay creates are avoided.

## Provider references

- [Razorpay order creation](https://razorpay.com/docs/api/orders/create/)
- [Razorpay checkout and capture states](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
- [Cashfree create order](https://www.cashfree.com/docs/api-reference/payments/latest/orders/create-order)
- [Cashfree get order](https://www.cashfree.com/docs/api-reference/payments/latest/orders/get-order)

Validation: `node --test tests/company-payment.test.cjs` and `npm.cmd run build`.
Automated tests mock gateway HTTP responses; real sandbox checkout still requires configured credentials.

## Frontend setup and checkout sequence

1. Request `GET /v1/admin/payments/providers` for supported providers and credential labels.
2. A company administrator submits POST `/v1/admin/payments/gateways` once per mode. For Cashfree use `provider: "cashfree"`, with its App ID in `key_id` and Secret Key in `key_secret`.
3. Request GET `/v1/admin/payments/gateways` to show configured metadata; secrets are never returned.
4. Create a test order or an order using a fresh `Idempotency-Key` header. Reuse that key when retrying the same order request.
5. Pass `data.checkout` to your provider checkout integration. Keep `data.id` as the local order ID.
6. After checkout, POST `/v1/admin/payments/orders/<local-id>/verify`. Display success only when the returned `data.status` is `paid`.

Example configuration response (HTTP 201; generated IDs/timestamps vary):

```json
{
  "success": true,
  "message": "Payment gateway created",
  "data": {
    "id": "generated-gateway-uuid",
    "provider": "razorpay",
    "mode": "test",
    "display_name": "Client Store",
    "active": true,
    "credentials_configured": true
  }
}
```

This saves an existing merchant account's credentials; it does not create a merchant account at the payment provider or validate credentials remotely. Use the test-order endpoint to check the test connection. `passwordReset.model.ts` has no role in payment configuration. The API remains authenticated; it does not provide public payer order-creation endpoints.

## Live checkout with the HTML page

Configure live credentials using POST (or PUT to replace) `/v1/admin/payments/gateways` with `mode: "live"`. Serve `docs/payment-test.html` from your frontend HTTP/HTTPS origin allowed by API CORS. Enter the API origin, company administrator JWT and customer phone, select **Live (real payment)**, and enter the amount in paise. Click **Open live checkout** and complete payment. The page verifies the local order through the backend; use **Check payment status** again if it remains pending.

The live request is `POST /v1/admin/payments/orders` with `Authorization: Bearer <JWT>`, `Content-Type: application/json`, and `Idempotency-Key: <unique-attempt-key>`:

```json
{ "mode": "live", "amount_paise": 100, "customer_phone": "9999999999" }
```

Verify using `POST /v1/admin/payments/orders/<data.id>/verify` with the same JWT. Creating an order opens the payment flow; completing live checkout collects real money. No automatic refund is made. Test mode calls `/test-orders` instead. Cashfree uses `production` for live checkout and `sandbox` for tests, as shown in its [official SDK example](https://www.cashfree.com/devstudio/preview/pg/embed/webCheckout).

## Live checkout completes but the local order stays pending

The HTML page releases the Razorpay completion callback before waiting for backend verification, bounds each API request to 20 seconds, and rechecks the same order up to 12 times with three-second gaps. It also verifies after dismissal or a failed checkout event, since browser events alone are not proof of payment. Manual Check payment status uses the same verification flow.

The local order changes to `paid` only when the provider confirms payment with the expected order ID, amount and currency. For Razorpay this requires a paid order with the full amount paid and zero amount due. An `authorized` payment still needs capture; review your merchant account's capture settings or the individual payment in the Razorpay dashboard. The app does not automatically capture payments. See [Razorpay payment capture settings](https://github.com/razorpay/markdown-docs/blob/master/payments/payments/capture-settings.md).

If Razorpay already shows the order paid, call POST `/v1/admin/payments/orders/<local-order-uuid>/verify` using the company's JWT and inspect the response. Use the local UUID, not Razorpay's `order_...` ID. Browser polling runs only while the page remains open; payment webhooks/background reconciliation are not implemented in this module. A frozen Razorpay merchant dashboard itself cannot be diagnosed from the local checkout page.

## Buy a subscription and activate its user plan

Apply `20260928000001_link_payment_user_plans.ts` before deploying this code. It links a payment order to one `user_plans` record and records `fulfilled_at`. Existing amount-only orders are not retroactively linked. No migration was applied during implementation.

Create using `POST /v1/admin/payments/orders` with a company administrator JWT and an `Idempotency-Key`:

```json
{
  "mode": "live",
  "subscription_plan_id": "<company-subscription-plan-uuid>",
  "user_id": "<recipient-user-uuid>",
  "customer_phone": "9999999999"
}
```

`user_id` is optional and defaults to the authenticated user. It must belong to that company. The selected active Monthly/Yearly plan must belong to the company; Free and global platform plans are not purchasable through a company merchant account. Omit `amount_paise`: the server converts `subscription_plans.price` from INR to paise and snapshots its price, name, limits and billing cycle. Reusing the same idempotency key returns the same order and pending plan, even if the catalogue price changes later.

Alternatively, POST `/v1/admin/subscription/<plan-id>/activate` with the same headers and body, omitting `subscription_plan_id`. Despite the legacy route name, this now creates a pending purchase, not active access. It replaces the old environment-key order flow for this route.

Creation returns the existing order/checkout fields plus `user_plan_id` and `fulfilled_at: null`. The user plan is `active: false`, `status: "pending"`; the current active plan is untouched. A provider timeout leaves the reserved plan inactive and the order `creation_unknown`, requiring reconciliation instead of blindly creating another charge.

After checkout, POST `/v1/admin/payments/orders/<local-order-id>/verify`. The subscription alias is POST `/v1/admin/subscription/verify-payment` with:

```json
{ "order_id": "<local-payment-order-uuid>" }
```

The alias now accepts the local order UUID rather than the legacy Razorpay signature payload. Both endpoints fetch provider status with the stored gateway credentials. Pending/authorized/failed payments never grant access. Verified payment atomically marks the order `paid`, activates the linked plan with status `COMPLETED`, sets `users.assigned_plan` to that user-plan ID, and records `fulfilled_at`. Activation dates start at fulfillment; existing remaining paid time follows the shared plan-duration rules. Existing active plans become cancelled/expired, and team-seat usage is carried into the new plan. Duplicate or concurrent verification does not create another plan or extend its expiry again.

Test orders cannot purchase plans. Verified live subscription fulfillment debits the company wallet and credits the platform superadmin wallet: INR 100 Monthly or INR 1000 Yearly, using subscription_commission ledger entries. The transfer and activation share one transaction and are guarded by fulfilled_at. If funds have become insufficient since creation, top up and verify the same order again; do not create/pay another order. Existing refunds/cancellations are not automatically synchronized from the provider. Verification is invoked by the HTML page after checkout; there is still no automatic webhook/background fulfillment when that page is closed.

In `payment-test.html`, enter the subscription UUID and optional recipient UUID and select Live. The editable amount is ignored for subscription purchases; the backend returns the actual catalogue amount used by checkout.

## Simple subscription checkout page

Serve [subscription-checkout.html](subscription-checkout.html) from your frontend HTTP/HTTPS origin allowed by API CORS. Enter the API origin, company administrator JWT, subscription UUID, customer phone and optionally the recipient user UUID. Click **Pay for subscription**. The page creates a live order using the saved subscription price, opens the returned provider checkout, then automatically calls POST `/v1/admin/payments/orders/<data.id>/verify`. It shows activation only when the verified order includes `fulfilled_at`. Use **Check payment status** if confirmation is delayed. Keep the page open through verification; no JWT is saved in browser storage.

## Company credit eligibility for subscription orders

Before reserving a new paid user plan or calling the gateway, the backend checks the authenticated company's `companies.credit_balance` inside the order transaction. Monthly plans require at least INR 100; Yearly plans require at least INR 1000. Equal balances are accepted. Missing, invalid or insufficient balances return HTTP 400 without creating an order or pending plan. Request-body balance/company overrides are ignored. Creation only checks the balance. Successful live payment verification rechecks it and records the debit/credit with `balance_before` and `balance_after` when activating the plan. Amount-only payments are unchanged. Retrying an existing idempotent order returns that order without rechecking the wallet.
