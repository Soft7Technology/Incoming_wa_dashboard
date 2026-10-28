# Business & Ads review flow

Open `/v1/facebook/ads` on the same API host as the existing public Meta pages.
The page creates a private browser workspace and uses real Facebook authorization,
business portfolios, owned/client ad accounts, campaign lists and Insights data.
It can create a traffic campaign with `status=PAUSED`, no ad sets, ads or budget.
No campaign is created until the visitor enters a name, checks the confirmation,
and presses **Create paused campaign**.

## Configure and run

1. Apply migration `20261025000001_create_facebook_ads.ts` using the existing migration process.
2. Keep the existing Facebook app ID/secret, encryption key and public URL. Configure
   an active **Marketing API** version in `FACEBOOK_ADS_GRAPH_VERSION` (v26.0 at implementation); a version that
   still works for Messenger may already be retired for Marketing API calls.
3. In Facebook Login for Business, check the existing login configuration includes
   `business_management`, `ads_read`, `ads_management`, `pages_show_list` and
   `pages_read_engagement`. The flow reuses `FACEBOOK_LOGIN_CONFIG_ID` from `.env` by default. Set
   `FACEBOOK_ADS_LOGIN_CONFIG_ID` only when using a dedicated configuration. Ensure
   the selected configuration includes all the permissions above.
   If this app supports classic Facebook Login instead, explicitly set
   `FACEBOOK_ADS_LOGIN_MODE=classic` to request those scopes directly.
4. Add `https://YOUR_API_HOST/v1/facebook/ads/oauth/callback` to Valid OAuth Redirect URIs.
   Leave the existing Messenger, posts, leads and Instagram callbacks configured.
5. Use the existing signed `/v1/facebook/deauthorize` and
   `/v1/facebook/data-deletion` callbacks and `/v1/facebook/privacy` privacy URL.
6. Build with `npm run build`, restart the API, and open the page. Select your own
   business and an ad account your Facebook user can access. Development testing
   must use accounts eligible under the app's current access level.

Business & Ads can reuse the existing `.env` Facebook login configuration. A
dedicated `FACEBOOK_ADS_LOGIN_CONFIG_ID` overrides it when configured. The returned
token is checked for every required ads permission before saving. Missing configuration
is displayed on the page. Tokens remain encrypted on the server and are never sent
to the browser. Account reads and creation recheck membership in the chosen business.
Disconnect deletes local credentials and action history. Signed Facebook revocation
and deletion remove the matching user authorization. Campaigns already created on
Meta remain in the ad account; manage or remove them through Ads Manager.

For a local review server without background schedulers, run
`npm run facebook:ads:review` and open `http://localhost:8002/v1/facebook/ads`.
Set `FACEBOOK_ADS_REVIEW_PUBLIC_URL` to your HTTPS tunnel origin before starting
that server for Meta login. It changes the public URL only in that process and
uses the app credentials and login configuration in `.env`. Register the exact
HTTPS callback in Meta.

## Recording order

Use an authorized ad account with real historical delivery data. A new or sandbox
account may have no Insights rows. Select **Last 90 days** when useful. Empty states
are truthful and are not a substitute for a recording showing actual reporting data.

1. Start recording at `/v1/facebook/ads`, before connecting Facebook.
2. Press **Connect Facebook**. Show the complete Meta login, permission consent,
   asset selection and return to the application. Do not record passwords or tokens.
3. Show the connected status and granted permissions.
4. Select a **Business portfolio**. Show its owned/client **Ad accounts**, then
   select the account to manage. This demonstrates the business asset workflow.
5. Show the reporting period and real **Spend, Impressions, Reach, Clicks** and the
   available action/conversion breakdown returned by Meta. Explain any missing
   conversion data accurately; do not relabel every action as a conversion.
6. Show the campaign list. Enter a unique name such as `Surefy review paused campaign`,
   check the creation confirmation, and click **Create paused campaign**. Show the
   returned campaign ID and its `PAUSED` status in the refreshed list. This demonstrates
   the write use case for `ads_management`.
7. Optionally open the same campaign in Meta Ads Manager to corroborate its ID/status,
   then return to the app. Keep application actions visible in the recording.

Do not run paid ads solely to prepare a review video. Use existing permitted delivery
data. The recording is supporting evidence; approval remains Meta's decision.

## App Review submission

Open [Meta App Dashboard](https://developers.facebook.com/apps/), select the app,
and find the relevant use case's permissions or **App Review → Permissions and
Features**. Request the access level required to serve external businesses and
complete the verification and access requirements shown in your dashboard.
Meta's [Permissions Reference](https://developers.facebook.com/documentation/development/permissions)
currently lists `pages_show_list` and `pages_read_engagement` as dependencies for
`business_management` and `ads_management`; confirm all required dependencies in
your own dashboard.

Suggested descriptions, to adapt to the app's actual use:

- **business_management:** Surefy lets a business authorize its Meta portfolio,
  list its owned and client ad accounts, and select the account whose advertising
  it wants to monitor and manage. We use the Business Manager API for this asset
  selection and verify the account belongs to the selected authorized portfolio.
- **ads_read:** Surefy retrieves Ads Insights for the user's selected ad account
  and period and displays spend, impressions, reach, clicks and available attributed
  action metrics in its reporting screen.
- **ads_management:** Surefy lets an authorized business explicitly create a
  traffic campaign in its selected ad account. The initial campaign is paused;
  the app displays its ID, objective and status in the campaign list. This write
  operation requires ads_management beyond read-only reporting access.

Provide the reachable HTTPS page URL and the exact steps above. This page needs no
separate application email/password. Facebook authorization and eligible assets are
still required; it does not expose the developer's connections to another browser.
Explain the reviewer's supported test asset/account setup in the submission as
required by Meta. A token-only demonstration does not show the complete login flow.

References: [Permissions and screencast requirements](https://developers.facebook.com/documentation/development/permissions),
[Business owned ad accounts](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/business/owned_ad_accounts),
[Business client ad accounts](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/business/client_ad_accounts),
and [Campaign creation](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/campaigns).
