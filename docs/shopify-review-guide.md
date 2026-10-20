# Soft7 Shopify review setup

Prepared 17 October 2026. The app is not submitted or approved by this preparation.
The current deployment is a development API on a laptop through ngrok. Local code and
tests are evidence of implementation, not proof that the company's operational controls
or Shopify dashboard settings meet the requirements.

## Where Shopify gets the links

In the Dev Dashboard, open **Apps > Soft7 > Versions**. Open the active version to
inspect its URLs; use a new version to change configuration and release it. The older
Partner Dashboard may present app URLs in Configuration or App setup.

Use this public origin:

`https://ea13-2401-4900-8fea-1cc3-f8ac-28c8-9ea8-a7ab.ngrok-free.app`

| Shopify field | Value (append the path to the origin above) |
| --- | --- |
| App URL / `application_url` | `/v1/integrations/shopify/app` |
| Allowed OAuth redirection / `[auth].redirect_urls` | `/v1/integrations/shopify/callback` |
| Customer data request webhook | `/v1/integrations/shopify/webhook` |
| Customer data erasure webhook | `/v1/integrations/shopify/webhook` |
| Shop data erasure webhook | `/v1/integrations/shopify/webhook` |
| Listing privacy policy URL | `/v1/integrations/shopify/privacy` |

The draft `shopify.app.review.toml` already contains the app URL, callback, scopes and
all three compliance topics. It has not been released. After reviewing the app identity,
an authenticated Shopify CLI can deploy it with `shopify app deploy --config review`.
That deploy releases Shopify configuration; it does not host this Node API or submit
the App Store listing. Editing `.env` or the TOML file on disk alone does not publish
the production configuration.

The current UI is standalone: keep `embedded = false`. The backend must use the same
callback URL as the released Shopify configuration. If the domain changes, update the
backend settings, released configuration, listing privacy URL and testing instructions,
then reconnect/synchronize store subscriptions.

## Review submission fields

Open **Distribution > Manage submission** / **Shopify App Store review**.

1. Complete Configuration setup and the listing. Set the privacy URL above and accurate
   contact details; describe only the event inbox and implemented optional WhatsApp
   utility order notifications.
2. Request Protected customer data and Phone. Do not request Name, Email or Address
   for the current supported mappings. Phone reason: “To send WhatsApp order updates
   to consenting customers using their default or billing phone number.”
3. Complete Data protection details using actual deployed controls. Use
   `shopify-security-operations.md` to gather evidence; an unchecked control must not
   be represented as implemented.
4. In private App testing / Testing instructions, provide a dedicated reviewer login,
   login domain, exact setup steps, available sender/template and a short screencast.
   Never put passwords in the public listing, code, privacy page or this guide.
5. Run Shopify's automated checks, resolve failures, then submit. Shopify reviewers
   install and exercise the app, compare its behavior with the listing and requested
   data, and may request further evidence or fixes by email.

Shopify does not discover your local files. Its released app configuration and submitted
listing/testing instructions are how it finds and evaluates the running app.

## Reviewer login prepared locally

`npm run shopify:review-account` creates a separate, empty development tenant and a
random password. It never reuses a merchant account or rotates existing credentials.
It was run successfully; login and an empty scoped Shopify connections response were
verified. The credentials are only in ignored `tmp/shopify-review-login.json`.

This account has no WhatsApp sender, approved template or connected Shopify store. It
is not a complete live messaging demonstration. Do not share another merchant's login
or attach a production store to it. Provision the final reviewer tenant in the deployed
environment with dedicated test assets, check its OS file permissions, and supply its
credentials only through Shopify's private testing fields. Disable it after review.

## Demonstration checklist

The user-provided development store is `my-store-pvotisf6.myshopify.com`. A connected
record exists locally with selected order/customer topics and no stored subscription
issue. Live Shopify queries also verified this store's identity, `read_orders` and
`read_customers` scopes, and seven order/customer/lifecycle subscriptions pointing at
the current app destination. Expired credentials were refreshed through the app's normal
serialized token flow. This is not evidence that all compliance subscriptions are
released in Shopify, or that Phone access is approved.

Record a short walkthrough with test data:

1. Open the app in a fresh browser without needing a tunnel bypass. Sign in with the
   dedicated reviewer account. Install/connect a development store, approve OAuth and
   verify return to the app. Test both App Store-style entry with a `shop` query and
   connection from the app, plus reinstall; the former still needs live validation.
2. Save `orders/paid` as a trigger. Select an owned active WhatsApp sender and an
   approved UTILITY template. Map its parameters to order fields.
3. Show a real consent control in the test storefront or existing merchant consent
   integration. It must be optional and unchecked by default. If consent is given,
   persist `soft7_whatsapp_opt_in=true` in the order's `note_attributes`. Do not set
   it automatically or infer it from a phone number. A storefront consent integration
   has not been installed by this backend preparation.
4. Use a dedicated consenting test recipient and an international phone number to
   place/pay a test order. Show Shopify event receipt, one queued job, sender result
   and receipt in WhatsApp. Repeat without consent and show the skip reason. Do not
   message real customers for the demonstration.
5. Request access/export through Shopify, show the complete downloaded export and
   explicit delivery confirmation. Trigger customer erasure for that test customer,
   run maintenance and verify event/message deletion and send suppression.
6. Uninstall the test app and verify credential clearing; verify shop erasure against
   a disposable test installation. Never send a shop-erasure test for an active
   merchant store with real records.

The automated suite tests signed HTTP compliance delivery, access/export, customer
erasure and shop erasure against isolated fixtures. PostgreSQL checks use a temporary
schema and rollback. These are not Shopify-generated live events. No customer message
was sent by this preparation.

## Current verification

Run `npm run check:shopify:review` for public HTTP checks and a read-only database
transport/schema check. It intentionally fails while deployment issues remain and
writes safe evidence to `tmp/shopify-review-evidence.json`.

On 17 October 2026, ordinary HTTP requests reached the app and privacy page and rejected
unsigned webhooks. A fresh Edge browser still received the ngrok warning instead of
the app. The database connection was not using TLS, and NODE_ENV was development.
These are unresolved deployment items. Do not mark the app production-ready from
successful local tests or a 200 response alone.

References: [configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration),
[submission](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review),
[review testing](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review),
[protected data](https://shopify.dev/docs/apps/launch/protected-customer-data).
