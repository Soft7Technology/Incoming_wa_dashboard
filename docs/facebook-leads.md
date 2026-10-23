# Facebook Lead Forms setup and App Review

Open `https://YOUR_HOST/v1/facebook/leads` directly and connect through Meta; no application login is required. Each visitor receives a separate browser workspace. See [Public Meta workspaces](public-meta-workspaces.md) for the required migration and public API paths. The workspace connects a Facebook Page, lists its Instant Forms and questions, lets the visitor enable selected forms, imports submitted answers, and receives new leads through the signed Page `leadgen` webhook. Leads remain isolated to their owning workspace.

## Configure and deploy

1. Set the existing `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_GRAPH_VERSION`, `FACEBOOK_PUBLIC_URL`, `FACEBOOK_TOKEN_ENCRYPTION_KEY`, `FACEBOOK_WEBHOOK_VERIFY_TOKEN`, `JWT_SECRET`, and privacy controller/contact settings. Use an active Graph version supported by your Meta app. Never put Page access tokens in `.env`.
2. Under **Facebook Login for Business → Configurations**, create a configuration for Lead Forms using a **user access token** and Page assets. Request `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `leads_retrieval`, and `pages_manage_metadata`. Include any dependencies Meta requires for this app/use case. Set its ID in `FACEBOOK_LEADS_LOGIN_CONFIG_ID`. Messenger continues to use `FACEBOOK_LOGIN_CONFIG_ID`. Explicitly configured classic Facebook Login requests these five scopes directly.
3. Add `https://YOUR_HOST/v1/facebook/leads/oauth/callback` to **Valid OAuth Redirect URIs**. Keep the existing Messenger callback if you use both integrations.
4. Configure the app's **Page** webhook callback as `https://YOUR_HOST/v1/facebook/webhook`, using the configured verify token. Subscribe the app to `leadgen`. The workspace subscribes and verifies the selected Page when it connects. Both Messenger and Lead Forms use this same signed callback.
5. Configure the privacy URL as `/v1/facebook/privacy`, deauthorization callback as `/v1/facebook/deauthorize`, and data deletion callback as `/v1/facebook/data-deletion` on the same HTTPS host. Check the deployment's main privacy policy and retention rules before submitting.
6. Build and deploy this API and run the database migrations, including `20261014000001_create_facebook_leads.ts`, using the repository's normal deployment process. For a source checkout, use `npm run build` and `npm run migrate:latest`. Run the migration before serving traffic with this version; Messenger now also checks the lead connection table when changing subscriptions.
7. Assign the authorizing person the appropriate Page access. If Leads Access is customized, assign both the person and the CRM/app under **Business Settings → Integrations → Leads Access**. Create at least one Instant Form on that Page.

The connection uses actual Meta authorization and validates the granted permissions. A Meta-side dependency or asset assignment may require more permissions or configuration than this baseline. The workspace does not create forms, campaigns or ads, fetch advertising performance, or send messages to the submitted leads.

## Demonstrate each permission

| Permission | Implemented use | Recording evidence |
| --- | --- | --- |
| `pages_show_list` | `/me/accounts` returns authorized Pages | Facebook consent followed by Page selection |
| `pages_read_engagement` | `/{PAGE_ID}?fields=id,name` reads the selected Page | Connected Page name from Meta |
| `pages_manage_ads` | `/{PAGE_ID}/leadgen_forms?fields=id,name,status,questions` reads existing forms | Choose forms and expand Form questions |
| `leads_retrieval` | `/{FORM_ID}/leads` and `/{LEAD_ID}` read submitted answers | Enable syncing, import leads, and display the submitted answers |
| `pages_manage_metadata` | `/{PAGE_ID}/subscribed_apps` subscribes to and verifies `leadgen` | Verified webhook status, followed by a new submission arriving automatically |

1. Open the deployed workspace directly; no application credentials are required.
2. Click **Connect Facebook Page**, complete the real Facebook authorization and grant the requested access.
3. Select the test Page and show **Connected · lead webhook verified**.
4. Click **Choose forms**, select an existing Instant Form, and expand its questions.
5. Click **Enable syncing**, then **Sync existing leads** and **View submitted leads**. Use test submissions with representative answers and no unrelated personal data in the recording.
6. Open [Meta's Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing/) and submit a test lead for the selected form. Return to **View submitted leads**; this view refreshes every five seconds. Show the actual submitted answers appearing. Check development-mode app roles and testing eligibility in Meta if the test lead cannot be read.
7. Show **Disable syncing** or **Disconnect** to demonstrate the owner's control. **Delete stored integration** removes the Page connection, forms and stored leads; use it only after recording the retrieval flow.

## Test with a generated user token

For the configured **Random test** account, the supplied token is provisioned on the server. The `FACEBOOK_LEADS_PRESET_*` settings bind its encrypted credential to the existing company owner, with a shortcut to the configured Page. That owner sees **Connect Random test** and **Connect another Page**. The shortcut connects only the configured Page; **Connect another Page** lists every Page authorized by the saved user token and lets the owner select one. The existing-token entry panel remains available for another user token. The saved credential cannot be used by other company owners or team members. Connecting another Page preserves existing connections and their forms/leads. Forms must already exist on the selected Facebook Page to appear here.

The saved test credential is operator deployment configuration. Remove `FACEBOOK_LEADS_PRESET_TOKEN_CIPHERTEXT` from the deployment environment and `.env` when retiring this test setup; deleting the stored Page integration removes its database credentials and lead data, while operator provisioning can otherwise recreate the connection on an explicit owner request.

The workspace also accepts an existing **USER access token** generated by the same Meta app. Sign into `/v1/facebook/leads` with a company owner account, expand **Connect with an existing Facebook token**, paste the token and click **Validate token and choose Page**. The backend verifies the app ID, token type, expiration and required grants before listing Pages. Select a Page to connect; the same form selection, webhook verification and syncing flow follows.

This route does not need `FACEBOOK_LEADS_LOGIN_CONFIG_ID`. The Facebook Login button still requires that configuration in business mode. The user token is cleared from the input, is never stored in browser storage, and is not retained on the server. Only encrypted Page candidates remain for fifteen-minute Page selection; connecting consumes those candidates and saves an encrypted Page token under the company owner. Use the Facebook-hosted authorization flow when recording consent for App Review.

For the test Page **Random test**, select that Page when creating an Instant Form in **Meta Business Suite → All tools → Instant Forms → Create form**. Include representative name, email and phone questions, provide the business privacy policy, and publish. Then choose **Reload forms** in this workspace, enable the published form, and submit a test lead using the Meta Lead Ads Testing Tool. In the app dashboard screenshot, **Capture & manage ad leads** is the relevant use case for this integration; a sandbox ad account is used for ads testing rather than Page form selection.

A read-only diagnostic command is available after building:

```powershell
npm run facebook:leads:check -- --page 1408867788967562
```

It reads the encrypted token file at `.facebook-test-runtime/facebook-leads-token.json`, validates grants and lists Page/form metadata. Use `--token-file PATH` for another encrypted JSON file containing `token_ciphertext` generated by the application's encryption helper. The file is local, ignored by Git, and not copied into deployment assets. The command prints no tokens or submitted lead answers.

## Request Advanced Access

Open [Meta App Dashboard](https://developers.facebook.com/apps/) and select the app. Depending on the dashboard, find the relevant use case's permission settings or **App Review → Permissions and Features**. Request **Advanced Access** for the implemented permissions and any required dependencies. Complete business verification and other requirements shown by Meta before serving external businesses.

Provide the deployed workspace URL, step-by-step reviewer instructions and a recording showing the actual permission use. The public workspace opens without an application login; reviewers authorize their own eligible Meta assets.

Suggested explanation to adapt to your business:

> Our CRM lets an authorized business owner connect a Facebook Page and choose which existing Instant Forms to sync. We list the owner's Pages and read the selected Page's name and form questions so they can choose the correct source. We use leads_retrieval to import the answers submitted by people through those forms and display them in the owner's account. We use pages_manage_metadata to subscribe the Page to leadgen webhooks, verify the subscription and retrieve new submissions automatically. The owner can disable a form, disconnect a Page, or delete its stored forms and leads. We verify webhook signatures, encrypt Page tokens, isolate accounts, deduplicate submitted leads, and handle signed Meta deauthorization and data-deletion requests.

Describe `pages_manage_ads` as access to the existing forms implemented here. Do not claim the app creates or manages advertising campaigns to justify a permission.

## Sync behavior and troubleshooting

- Form selection applies to future webhook processing and manual imports. Disabling a form retains previously stored leads. Disconnect removes credentials and stops new imports; reconnect preserves the Page/form identity and stored leads.
- Existing leads are read in batches of 100 using opaque Meta cursors. The browser follows cursors to completion. Duplicate lead IDs within a form are skipped. The displayed lead list is paginated and refreshes its newest 100 records automatically.
- Leads that Meta no longer exposes cannot be imported. Failed imports can be retried with **Sync existing leads**. This also recovers submissions missed while syncing was disabled or the server was unavailable.
- Webhook failures return a non-success response for Meta redelivery. Form-level errors are stored and shown when forms are opened again. Manual sync can recover a failed webhook import. Configure app monitoring for webhook failures in the deployment.
- `subscription_failed`: check the app's Page `leadgen` subscription and metadata permission, then reconnect.
- Permission errors: check grants, app access levels, selected Page assets, Page tasks and customized Leads Access. Check the current endpoint requirements and app dependencies before adding broader permissions such as `ads_management` or `business_management`.
- A Page is assigned to a single company owner across both integrations. Connecting/disconnecting one feature retains the other's webhook fields when it remains connected.
- Signed deauthorization removes credentials in both integrations. Signed deletion removes Page credentials, conversations, forms and lead answers associated with that Facebook authorization, even when the local owner is suspended.

## Validation

The production build passed and all 50 Facebook tests passed with no skips against an isolated local PostgreSQL database and real Chromium. The Lead Forms browser test exercised login, token import with a cleared input, Page/form selection, enabling sync, importing existing answers, automatic arrival of a new webhook lead, mobile layout, the saved-token flow without a token prompt, and logout. These tests use controlled Meta responses.

The supplied token was separately validated against Meta: it is a valid USER token for the configured app and grants the required lead permissions. The missing Lead Forms tables were migrated into the configured database. The duplicated HTTPS prefix in the public URL was corrected, the current ngrok webhook callback was verified, and Meta's Page app subscription was updated to include `leadgen`. The Page **Random test** (`1408867788967562`) is connected, its **Test form** is enabled, and a Meta-generated test lead arrived automatically through the signed live webhook. Facebook-hosted consent must still be recorded for App Review.

The supplied token no longer grants `pages_messaging`, including on the previously stored Messenger Page credential. The Messenger connection is marked `reconnect_required`; lead syncing uses the valid lead permissions. To run both features together, authorize a token covering both Messenger and lead permissions. A Lead Forms connection preserves a working Messenger subscription if no credential grants both features and reports the dependency rather than replacing the working fields.

Run `npm run build`. For database and HTTP tests, set `FACEBOOK_TEST_DATABASE_URL` to an isolated **local** PostgreSQL database and run `npm run test:facebook`. Set `FACEBOOK_TEST_CHROME` to a Chrome executable to include browser tests. These tests use controlled Meta responses; only the deployed recording procedure establishes a live Meta round trip.

Primary references: [Meta lead retrieval guide](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/), [Page leadgen forms reference](https://developers.facebook.com/docs/graph-api/reference/page/leadgen_forms/), [Permissions reference](https://developers.facebook.com/docs/permissions/), and [Meta's official webhook example](https://github.com/fbsamples/lead-ads-webhook-sample). Meta documentation returned access/rate-limit errors during implementation; confirm current dashboard labels, active Graph version, endpoint requirements and dependency permissions in your app before recording or submitting.
