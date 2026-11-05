# Plan upgrades through Razorpay Payment Links

The customer selects a company-owned paid plan, the API creates a fixed-price link, and Razorpay hosts checkout. Verified live payment activates the saved user-plan snapshot automatically. The frontend needs no Razorpay checkout SDK or merchant secrets.

This endpoint purchases the selected plan at its full saved catalogue price. It is not a prorated price-difference calculation. The current plan stays active until payment fulfillment; the existing plan-duration/remaining-time rules apply at fulfillment. This endpoint supports plans, not standalone add-on purchases.

## Backend deployment and company setup

Apply `20261104000002_company_payment_links.ts` after the existing company-payment and plan migrations. To apply only this migration when the earlier migrations are already installed:

```powershell
npm.cmd run knex -- migrate:up 20261104000002_company_payment_links.ts
npm.cmd run knex -- migrate:up 20261104000003_company_gateway_webhook_verification.ts
```

Keep `PAYMENT_GATEWAY_ENCRYPTION_KEY` configured and stable. Build/restart the API after migration. The API process runs reconciliation every ten seconds, claiming due purchases in batches; pending purchases normally recheck after a minute and request failures retry later. No separate queue/Redis worker is required for this flow. `WORKER_MODE=true` does not start this scheduler.

An administrator configures the company's own Razorpay account. All dashboard endpoints below require `Authorization: Bearer <JWT>`. POST creates the first active gateway per mode; PUT replaces it with a new configuration version.

```http
PUT /v1/admin/payments/gateways
Content-Type: application/json
Authorization: Bearer <company-administrator-JWT>

{
  "provider": "razorpay",
  "mode": "live",
  "display_name": "Example Company",
  "key_id": "rzp_live_REPLACE_ME",
  "key_secret": "REPLACE_ME",
  "webhook_secret": "A_SEPARATE_RANDOM_WEBHOOK_SECRET"
}
```

Use POST instead for first-time setup. The response includes `data.id`, `data.webhook_secret_configured`, and `data.webhook_path`. Secrets are encrypted, never returned, and must not be placed in customer checkout code. Ordinary users cannot modify gateway settings.

In that company's Razorpay dashboard, configure a webhook at your publicly reachable HTTPS API origin plus the returned path, for example:

```text
https://api.example.com/v1/webhooks/razorpay/company-payments/<gateway-configuration-uuid>
```

Use the same `webhook_secret` and select `payment_link.paid`, `payment_link.expired`, and `payment_link.cancelled`. The webhook authenticates Razorpay's signature over the original body; no JWT is sent by Razorpay. A notification durably requests verification; it does not grant access from event fields alone. The provider is fetched using the stored merchant credentials, and duplicate notifications cannot extend the plan twice.

The company needs an approved Razorpay account for live collection. Your platform hosts the webhook; a company-owned domain is not required for this integration. Configure test keys and a test-mode webhook separately when testing.

Credential updates create a new configuration ID/webhook path. Keep the old webhook and original credentials available for outstanding purchases; background verification also uses their original configuration. PUT must include `webhook_secret` again for new link creation. Disabling a gateway stops new purchases, not verification of existing purchases.

## Dashboard webhook verification status

After saving and configuring the webhook in Razorpay, refresh `GET /v1/admin/payments/gateways` using the company's administrator JWT. It returns the verification status for each active configuration, including the exact webhook path:

```json
{
  "data": [
    {
      "id": "<gateway-configuration-uuid>",
      "provider": "razorpay",
      "mode": "live",
      "webhook_secret_configured": true,
      "webhook_status": "verified",
      "webhook_verified": true,
      "webhook_verified_at": "2026-11-04T10:00:00.000Z",
      "webhook_path": "/v1/webhooks/razorpay/company-payments/<gateway-configuration-uuid>"
    }
  ]
}
```

| `webhook_status` | Dashboard badge | Meaning |
| --- | --- | --- |
| `not_configured` | Webhook setup required | The Razorpay configuration has no saved webhook secret |
| `pending` | Awaiting webhook verification | Secret saved; no valid payment-link delivery observed yet |
| `verified` | Webhook verified | Backend received and authenticated a supported payment-link notification |
| `not_applicable` | Hide this Razorpay badge | Another provider is selected |

Suggested frontend behavior: after saving, show the returned pending status and webhook setup instructions. While that settings panel is visible, poll GET every five seconds for the selected gateway ID/mode, or provide a **Refresh status** button. Stop polling when verified or when the panel closes; resume on reopening if still pending. Never call PUT to refresh status, because it creates a new configuration version. Do not send `webhook_verified` or a timestamp from the browser to mark setup complete.

To verify delivery, trigger a subscribed payment-link event in the matching Razorpay account/mode. For example, complete a test payment link in test mode. A supported signed notification from a dashboard-created link also verifies delivery even without a local app purchase reference. Saving the secret, opening the URL, fetching payment status, or receiving an invalid signature does not mark it verified. Link creation requires the secret to be configured but does not require the verified badge, allowing the first purchase to trigger verification.

`webhook_verified_at` records the first qualifying delivery and is preserved on retries. Existing configurations start unverified after this migration until a new signed event arrives. Replacing the gateway with PUT starts the new ID as pending even if the previous ID was verified; test/live configurations are independent. A late event to an old URL verifies only that old configuration. This badge records successful authenticated delivery; it does not continuously check whether the webhook remains enabled in Razorpay, and it is separate from payment capture and plan activation.

## 1. Create the upgrade purchase

```http
POST /v1/admin/payments/payment-links
Authorization: Bearer <JWT>
Idempotency-Key: <unique-key-for-this-purchase>
Content-Type: application/json

{
  "mode": "live",
  "subscription_plan_id": "<company-owned-paid-plan-uuid>",
  "customer_phone": "9999999999"
}
```

- `mode`: `live` or `test`; defaults to `live`.
- `subscription_plan_id`: required active Monthly/Yearly plan from this company. Free and global platform plans are rejected.
- `customer_phone`: optional ten-digit Indian mobile number.
- `user_id`: optional recipient; defaults to the JWT user. Only company administrators may specify a different user, who must belong to the same company.
- Do not send `amount_paise`, `company_id`, payment status, or gateway credentials. Other fields are rejected; the server reads and snapshots the catalogue price.

Reuse the same `Idempotency-Key` and body on network retries. A changed body with the same key returns an error. Do not generate a new key just because the request timed out.

HTTP 200 example for a saved ₹1,000 plan (additional envelope/response fields omitted):

```json
{
  "success": true,
  "message": "Plan payment link purchase",
  "data": {
    "id": "<local-purchase-uuid>",
    "amount_paise": 100000,
    "currency": "INR",
    "is_test": false,
    "status": "pending",
    "payment_flow": "link",
    "payment_link_id": "plink_EXAMPLE",
    "payment_url": "https://rzp.io/i/EXAMPLE",
    "link_status": "created",
    "activation_status": "awaiting_payment",
    "fulfillment_error": null,
    "user_plan_id": "<pending-user-plan-uuid>",
    "fulfilled_at": null,
    "checkout": {
      "provider": "razorpay",
      "mode": "live",
      "type": "payment_link",
      "payment_link_id": "plink_EXAMPLE",
      "payment_url": "https://rzp.io/i/EXAMPLE",
      "expires_at": "2026-11-04T12:00:00.000Z"
    }
  }
}
```

Save `data.id` before navigating. Render a normal link/button to `data.payment_url` (optionally in a new tab with `rel="noopener noreferrer"`). This URL can also be copied/shared through WhatsApp. Creating the link does not send SMS/email/WhatsApp messages. Partial payments are disabled, and links are created with a one-hour expiry.

`success: true` only means the API handled the request. If `status` is `creating` or `creation_unknown`, the URL may be null: show **Preparing payment link**, retain the purchase ID/key, and poll the same purchase. The backend looks up its unique reference to recover a link accepted before a timeout; it never blindly repeats the external POST. If no link can be found, an operator must reconcile the attempt before a new purchase is made.

## 2. Show payment and activation progress

Poll the saved local purchase UUID while the dashboard is open:

```http
GET /v1/admin/payments/orders/<local-purchase-uuid>
Authorization: Bearer <JWT>
```

GET reads saved state without calling Razorpay. Poll every 3–5 seconds while this screen is visible, stop on completion/expiry/cancellation, and stop or back off when the screen closes. Browser closure does not stop the backend scheduler.

For **Check payment status**, or once when the customer returns to the dashboard:

```http
POST /v1/admin/payments/orders/<local-purchase-uuid>/verify
Authorization: Bearer <JWT>
```

No request body or client payment signature is needed. Verification fetches Razorpay using the original gateway credentials and matches link ID, purchase reference, full saved amount and currency. Before activation, it also requires a captured, unrefunded payment for the linked provider order. A browser redirect, screenshot or client-submitted amount is never proof of payment.

| Response | Frontend behavior |
| --- | --- |
| `status: creating` / `creation_unknown` | Preparing/reconciling this purchase; do not create a second attempt |
| `status: pending`, link `created` | Show Pay now / Check payment status |
| `link_status: partially_paid` | No activation; payment incomplete, contact support if unexpected |
| `link_status: expired` / `cancelled` | Show link unavailable; after verifying terminal status, allow a deliberate new purchase with a new key |
| `status: paid`, `activation_status: active`, non-null `fulfilled_at` | Show Plan activated; refresh current plan and entitlements |
| `status: paid`, `activation_status: activation_pending` | Show Payment received, activation pending; never ask the customer to pay again |
| `activation_status: test_only` | Test payment only; never show a real plan upgrade |

An ordinary user can read their own purchase; administrators can read purchases within their company. No public unauthenticated purchase/status API is introduced.

Minimal browser request example (call from the existing authenticated dashboard):

```js
async function createPlanPaymentLink({ apiOrigin, token, planId, phone, purchaseKey }) {
  const response = await fetch(`${apiOrigin}/v1/admin/payments/payment-links`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': purchaseKey,
    },
    body: JSON.stringify({
      mode: 'live',
      subscription_plan_id: planId,
      ...(phone ? { customer_phone: phone } : {}),
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error?.message || result.message || 'Unable to create purchase');
  }
  return result.data; // Persist id; render payment_url if present; otherwise poll id.
}

// Generate once when the customer starts a deliberate purchase, then retain it
// for retries/reloads, scoped to the logged-in account and selected plan.
const purchaseKey = crypto.randomUUID();
```

## Activation policy and operational limits

The existing platform fee still comes from the company's wallet. Creation checks eligibility but does not reserve funds. If the company spends those credits before the payment arrives, the API records the money as received and returns `PLAN_ACTIVATION_PENDING`; it retries fulfillment automatically. The company administrator must top up the wallet if needed, then verify the same purchase. Other activation failures also require operator investigation; the public error intentionally contains no database/provider details. `PAYMENT_CAPTURE_REVIEW_REQUIRED` means the link is marked paid but an eligible captured, unrefunded payment could not be confirmed; keep activation pending and investigate in Razorpay, without prompting another payment.

Test links snapshot the catalogue plan and exercise payment verification but never activate it or transfer wallet funds. They still require a valid catalogue and the existing wallet eligibility check. Existing checkout-based orders remain supported. Refunds, disputes and reversals after activation are not automatically synchronized, and this release does not implement customer payment links for standalone add-ons.

Before going live, test creation/retries, full payment, closed-browser activation, expiry, invalid signatures, duplicate notifications and activation recovery using a test gateway. Automated tests mock provider HTTP; a real Razorpay sandbox checkout is a separate verification step.

Provider references: [create links](https://razorpay.com/docs/api/payments/payment-links/create-standard/), [find by reference](https://razorpay.com/docs/api/payments/payment-links/fetch-all-standard/), [fetch a link](https://razorpay.com/docs/api/payments/payment-links/fetch-id-standard), [webhook signatures](https://razorpay.com/docs/webhooks/validate-test/).
