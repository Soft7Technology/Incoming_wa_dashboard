# Company payment gateways

Base URL: `/v1/admin/payments`. All requests require `Authorization: Bearer <JWT>`.
The JWT company determines the merchant account; a payload `company_id` cannot select another company.
Company administrators (`admin`, `company`, `superadmin`) with a company context can configure gateways and create orders.
Other users can read/verify only their own orders. Administrators can read/verify orders within their company.

This module collects payments and records gateway-verified status. It does **not** activate subscriptions,
credit wallets, issue refunds, or replace the existing subscription payment endpoints. Those business actions
need separate, transactional fulfillment against a server-priced purchase. Customer-supplied amounts must not
be used to grant a plan. Payment success is checked using the verification endpoint, not an incoming webhook.

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
It is sandbox-only. For Cashfree, register the frontend domain in your gateway dashboard as required.
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
