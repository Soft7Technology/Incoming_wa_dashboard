# Instagram messages, comments and publishing

This integration supports **direct Instagram Login**, without a linked Facebook Page, and the existing **Facebook Login** alternative. Open `/v1/facebook/instagram` directly and choose **Connect with Instagram** or **Connect with Facebook**; no application login is required. Each visitor receives a separate browser workspace. See [Public Meta workspaces](public-meta-workspaces.md) for the required migration and public API paths. Visitors can connect their professional account, read and reply to customer DMs, and manage comments on its posts.

## Direct Instagram Login

1. In Meta's Instagram product, select **API setup with Instagram Login**. Copy its **Instagram App ID** and **Instagram App Secret** into `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET`. These credentials are distinct from the parent Facebook app credentials. Set `INSTAGRAM_AUTH_PROVIDER=instagram`, `INSTAGRAM_GRAPH_VERSION` to an active supported version and `INSTAGRAM_PUBLIC_URL` to your HTTPS origin. Keep the existing `FACEBOOK_TOKEN_ENCRYPTION_KEY` for encryption at rest; direct login does not need a Facebook login configuration or Facebook app credentials.
2. Add `https://YOUR-PUBLIC-HOST/v1/facebook/instagram/oauth/callback` to the Instagram product's allowed OAuth redirects. This callback path is shared with the existing workspace; the actual authorization goes to `www.instagram.com/oauth/authorize`, with Facebook login disabled.
3. Request `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, and `instagram_business_content_publish`. Publishing access is optional for inbox and comments, but required before publishing a post. Use a Business or Creator account; no Facebook Page is required. Configure app/test roles for development, and complete Meta's access requirements for external accounts.
4. Set `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` to your chosen verification value. Configure the Instagram product webhook callback as `https://YOUR-PUBLIC-HOST/v1/facebook/instagram/webhook`, using that verification token, and select **messages** and **comments**. This dedicated route checks the Instagram app secret. Keep Facebook's existing `/v1/facebook/webhook` callback for Facebook-authorized integrations. The shared callback also accepts direct Instagram deliveries signed with `INSTAGRAM_APP_SECRET`, including retries to older callback URLs; it routes those events only to direct Instagram accounts. An Instagram signature cannot authorize Page or lead-form events.
5. Configure the deauthorization callback as `/v1/facebook/instagram/deauthorize`, the data deletion callback as `/v1/facebook/instagram/data-deletion`, and privacy URL as `/v1/facebook/privacy` on the same host. Signed Instagram deauthorization/deletion affects only Instagram-authorized connections.
6. Apply the migrations below and restart the backend. Click **Connect with Instagram**, grant access in Instagram, and select the authorized account. The backend exchanges the code and long-lived token on Instagram endpoints, verifies the professional account, subscribes via `POST /me/subscribed_apps` and verifies both subscribed fields. Tokens remain encrypted on the server.

Direct connections use `graph.instagram.com` for profile, media, conversations, messages, comment replies and moderation. Accounts and OAuth sessions record the authorization provider and app ID. Each session binds its browser, provider, app and callback so changing configuration cannot reuse a pending authorization for another app. Direct account IDs and Facebook Page IDs remain separate; direct connections store no fake Page IDs. Active direct accounts renew their tokens when fewer than seven days remain, at most once per day; expired/revoked authorization requires reconnecting.

Inbox imports request ten conversations per page with participant details. Meta returned error code 1 for a live expanded fifty-conversation request while the same request succeeded with ten. Use **Import more conversations** to follow the next cursor. Instagram code 1/2 errors are reported as temporary upstream errors rather than Facebook Page or messaging-window errors. Instagram reads and webhook persistence do not use Redis; connection-refused queue logs indicate a separate background-service issue.

The optional **Connect with Facebook** button retains the linked-Page flow below. Set `INSTAGRAM_AUTH_PROVIDER=facebook` for API clients that omit the provider in `POST /v1/admin/instagram/oauth/start`; the browser buttons always specify their provider. The Instagram direct path uses `instagram_business_*` permissions, while Facebook login keeps its existing permission family.

Reference: [Meta's Instagram Login API collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login) and [Meta's Instagram Business Login guide](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/).

## Permissions to request

| Permission                  | Use in this application                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `instagram_basic`           | Discover the linked professional account, display its username and list its published posts.                                     |
| `instagram_manage_messages` | Read Instagram customer conversations and send the owner's replies. There is no separate `read_message` permission in this flow. |
| `instagram_manage_comments` | Read comments on the connected account's posts, publish public replies and hide/unhide comments.                                 |
| `pages_show_list`           | Let the owner select a Facebook Page they manage.                                                                                |
| `pages_read_engagement`     | Read the Page and its linked Instagram account metadata during selection and validation.                                         |
| `pages_manage_metadata`     | Subscribe the linked Page to message webhooks.                                                                                   |

These are the Facebook Login permissions. Direct Instagram Login uses the separate `instagram_business_*` permissions above. See [Meta's Instagram API collection](https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00) and [Meta's Instagram Conversations API requirements](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a).

## Configure Meta

1. In the same Meta app used by this server, add the Instagram use case/product and choose **API setup with Facebook Login**. Link a Business or Creator Instagram account to a Facebook Page. The Facebook person signing in needs Page messaging access. In Instagram's connected-tools/message settings, enable access to messages for connected tools.
2. Under Facebook Login for Business, create a configuration that issues a **User access token**, selects Page assets and includes the six permissions above. Set its ID as `INSTAGRAM_LOGIN_CONFIG_ID` in `.env`. Keep the existing Facebook app ID, secret, encryption key and public URL. No token needs to be pasted into this workspace. `INSTAGRAM_LOGIN_MODE=business` is the default; `classic` is only for apps configured to support classic Facebook Login.
3. Add `https://YOUR-PUBLIC-HOST/v1/facebook/instagram/oauth/callback` to Facebook Login's Valid OAuth Redirect URIs. The exact URL must match `FACEBOOK_PUBLIC_URL`.
4. Configure the app's **Instagram** webhook object with callback `https://YOUR-PUBLIC-HOST/v1/facebook/webhook` and the existing `FACEBOOK_WEBHOOK_VERIFY_TOKEN`. Subscribe to **`messages` and `comments`**, using the same supported API version. Keep the existing Page/leadgen webhook configuration. Callback verification alone does not subscribe these fields.
5. Connect in the application. The server lists eligible linked accounts, validates the selected Page and Instagram mapping, and subscribes the linked Page through `/{PAGE_ID}/subscribed_apps`, preserving existing Page fields. The dashboard's Instagram object subscription is a separate step.
6. During development, use accounts with appropriate app/test roles and accept required invitations. For accounts outside those roles, complete the app's business verification and request the required Advanced Access through App Review, as applicable to the app's dashboard requirements.

An existing Facebook lead-form token does not gain Instagram permissions automatically. The connection checks the permissions returned by Meta and reports missing grants. Only an owner completing consent with a correctly configured Meta login can authorize the new scopes.

## Database and deployment

Build with `npm run build`. Apply `20261015000001_create_instagram.ts` and then `20261015000002_add_instagram_login.ts` and `20261015000003_create_instagram_publications.ts` (or their compiled `.js` equivalents) using the repository's Knex configuration before running the updated API. The first creates `instagram_accounts`, `instagram_oauth_sessions`, `instagram_records` and `instagram_actions`; the second adds provider/app metadata and permits accounts without a Facebook Page. Existing connections default to the Facebook provider. If the database has older tables with incomplete migration history, apply the missing Instagram migrations specifically rather than running all pending migrations blindly. The second migration's rollback refuses to discard existing direct Instagram connections. The third adds granted permissions, temporary upload metadata and publication history.

Restart the application after configuration or compiled-code changes. The public workspace and assets are copied by the existing Facebook asset build step. Apply `20261023000001_create_public_meta_sessions.ts` for the browser workspace, which uses `/v1/facebook/api/instagram` with its HttpOnly cookie. Existing dashboard clients can continue using `/v1/admin/instagram` with their application JWT and owner permissions.

## Record the review videos

Use a test professional account and another Instagram account you control. Show the real application and the Instagram account receiving the result. Supply the public workspace URL and instructions for authorizing an eligible Instagram test account. No application login is required.

For **`instagram_manage_messages`**:

1. Open the public Instagram workspace. Click **Connect with Facebook**, show consent, choose the linked Page/Instagram account, and return to the connected account card.
2. From the other Instagram account, send a fresh DM to the professional account.
3. Click **Open account → Refresh inbox**, open the customer conversation and show the received text. The signed webhook also persists incoming messages while the integration is connected.
4. Type a reply and click **Send reply**. Show the reply arriving in the other account's Instagram inbox. Replies require a customer message within the last 24 hours.

For **`instagram_manage_comments`**:

1. From the other account, comment on a published post owned by the connected professional account.
2. Click **Refresh posts → Read comments** and show the comment in the application.
3. Enter a public reply and click **Reply to comment**. Show the reply on Instagram.
4. Click **Hide comment**, show the visibility change, then **Unhide comment**. Show the result from an appropriate viewer account; the author may still see hidden content.

For **`instagram_basic`**, show account selection, the connected username, the loaded posts and **View on Instagram**. For Page permissions, show the Page list, linked account selection and successful Page subscription during connection. The app's permission test counters must record actual authorized calls made by the same Meta app under review; local fixture tests do not count.

## App Review descriptions

### instagram_business_basic: direct Instagram Login

Our application uses instagram_business_basic to identify the Instagram professional account authorized by its owner and display that account's username and Instagram account ID in our authenticated dashboard. After Instagram Login and account selection, the Connected Instagram profile section shows the authorized profile, provides a link to view it on Instagram, and lets the owner refresh its username from Instagram. We also retrieve the account's published media so the owner can select their own posts for comment management. This helps owners confirm they connected the correct account and keeps messages, posts and comments associated with that account. The permission is necessary for profile identification and media retrieval. We request it as a dependent permission for both instagram_business_manage_messages and instagram_business_manage_comments, which support our customer inbox and comment management features. Our direct publishing feature also uses this account identity alongside instagram_business_content_publish.

Reviewer testing instructions:

1. Open `https://YOUR-PUBLIC-HOST/v1/facebook/instagram`.
2. The workspace opens automatically without an application email or password.
3. Click **Connect with Instagram**. Sign in to your own Instagram professional account on Instagram's authorization screen and grant the requested permissions. No Instagram account credentials are supplied by us.
4. Back in the application, choose your account under **Choose your Instagram account**, then click **Connect selected account**.
5. The account opens automatically. Under **Connected Instagram profile**, verify **Username**, **Instagram account ID**, and **Connection**. This is the profile authorized in the previous step. For an already connected account, click **Open account** on its card to view the same section.
6. Click **Refresh profile** to retrieve the current profile information from Instagram. Click **View profile on Instagram** to compare the displayed username with the authorized account.
7. Optionally click **Refresh posts** to load the account's own published media. An account with no published posts can still demonstrate profile access.

For the screencast, show the public workspace opening, Instagram authorization and return, account selection, and the resulting username/account ID in one continuous flow. Show **Refresh profile** retrieving the account again. Profile access does not require a test DM, comment, or post publication. Do not put application passwords in source documentation or supply Instagram credentials in the review submission.

The profile refresh API is `POST /v1/admin/instagram/accounts/:id/profile/sync`. It requires the authenticated company owner, verifies the returned Instagram account ID against the stored connection, and returns only public account metadata. Direct accounts use Instagram's profile endpoint; Facebook-authorized accounts retain their linked-Page lookup.

### instagram_manage_messages

Our application provides an Instagram customer-support inbox for businesses. After the business owner signs in with Facebook and selects a Facebook Page linked to their Instagram professional account, we retrieve that account's customer conversations and messages and display them in the owner's authenticated workspace. The owner opens a conversation, reads the customer's request and sends a manual reply through the Instagram messaging API. Signed message webhooks keep incoming messages available in the workspace. We permit replies only within 24 hours of the customer's latest message. This permission is necessary to read and respond to Instagram DMs; without it, our Instagram support inbox cannot function. It helps businesses answer customer questions from the same application they use for their other customer channels. We do not use this feature to send unsolicited messages.

### instagram_manage_comments

Our application lets a business owner manage customer comments on posts published by their connected Instagram professional account. After Facebook authorization and account selection, the owner loads their posts, opens a post's comments, reads customer questions, publishes manual public replies, and hides or unhides comments when moderation is needed. Comment webhooks update comments on posts already imported into the workspace. This permission is necessary to retrieve and moderate those comments and publish the owner's replies. It adds value by allowing businesses to answer questions and moderate their own Instagram posts from their authenticated customer-support dashboard.

### instagram_basic

Our application uses this permission to identify the Instagram professional account linked to the Facebook Page selected by its owner, show the account's username and list its published media. The owner selects one of these posts to view and manage its customer comments. This is necessary to connect the correct Instagram account and associate comment-management actions with that account's own posts.

## Data and operational limits

Instagram user tokens, Facebook Page tokens and temporary OAuth candidates are encrypted with the existing server encryption key. No Meta access token is returned to the browser. OAuth state is single-use and bound to the browser, company owner, login provider, app and callback. All content and action lookups are scoped to the selected account. The server reserves a client request ID before sending replies or changing comments; a repeated ID cannot submit the action twice, and an uncertain network result asks the owner to check Instagram before trying again.

Refresh buttons import cursor-based Meta result pages. The workspace displays up to 100 recent locally stored items per list. Importing earlier messages does not expand that display limit. Webhook delivery requires Meta configuration and suitable account access; the dashboard's sample webhook is not a substitute for a real customer DM/comment. No production simulator or artificial API-review counter is included.

Disconnect removes local credentials and stops processing new Instagram events; stored history remains readable until deleted. The subscription on Meta may remain, but disconnected accounts' events are ignored. For Facebook-authorized accounts, the Page webhook subscription is shared with Messenger and Lead Forms and is retained to avoid disrupting those connections. Delete stored integration erases the account, its content and action records. Verified Meta deauthorization clears credentials; verified data-deletion callbacks erase stored Instagram data associated with that provider's authorizing user. The shared privacy and deletion pages describe these controls.

## Direct login validation

Run `npm run build` and `npm run test:facebook` with the isolated database and Chrome environment variables used by the integration tests. Tests cover direct OAuth hosts and scopes, browser-bound single-use state, account ownership, independent Facebook/Instagram webhook signatures, DM replies, comment moderation, token renewal, signed deletion, existing Facebook integrations and the browser's direct Instagram login button. These tests use controlled Meta responses. A live Instagram account must still complete consent and the Meta product's redirects, webhook fields and app/test access must be configured before claiming a live Instagram round trip.

## Publish photos and Reels with Instagram Login

Publishing uses **instagram_business_content_publish** with **instagram_business_basic** on graph.instagram.com. Existing inbox connections must click **Connect with Instagram** again and grant publishing access, then choose their professional account. This feature uses direct Instagram Login and requires no Facebook Page; Facebook-authorized accounts must reconnect through Instagram to use it. Make the permission available in the Instagram product and satisfy Meta's access requirements before connecting external customer accounts.

1. Open /v1/facebook/instagram, connect, then click **Open account**.
2. Under **Create an Instagram post**, select a JPEG photo or MP4 Reel. Upload a file or enter a public HTTPS media URL; enter the caption. Reels optionally appear in the feed.
3. Click **Prepare post**. The server creates a media container and checks its processing status. A Reel may take time; use **Check status** or allow the minute-based polling to check up to five times.
4. Review the caption in the prepared card and click **Publish to Instagram**. After confirmation, **View published post** opens the actual Instagram permalink. The published item is added to the local posts list for comment management. If permalink retrieval fails, the publication remains confirmed; use Instagram or **Refresh posts** to find it.

The application supports single JPEG photos up to 8 MB and MP4 Reels up to 100 MB, with captions up to 2,200 characters. These are application upload limits; Instagram also validates media dimensions, aspect ratio, codecs and duration. PNGs, carousels, Stories, scheduling and editing existing posts are not implemented. A public URL must allow Meta to download the media without authentication. The server does not fetch user-supplied external URLs itself.

Uploads are saved under uploads/.instagram-publishing, configurable with INSTAGRAM_PUBLISH_UPLOAD_DIR. This folder must be persistent, writable and shared by API instances. Each validated upload receives an unpredictable public URL under /v1/facebook/instagram/publishing/media/:token, usable by Meta for 24 hours; no Meta token appears in that URL. File type signatures and sizes are checked, and upload records are account-scoped. Deleting the integration immediately removes its upload links. Expired/orphaned files older than 48 hours are removed during later upload activity; an idle deployment retains those files until cleanup next runs. The public HTTPS origin must route this endpoint to the API, including any tunnel-interstitial bypass required by the hosting provider. This publishing flow does not depend on Redis.

API routes require the existing authenticated company owner and account scope:

| Method and route, under /v1/admin/instagram/accounts/:id | Purpose                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET /publishing                                          | Publishing availability and grant status.                                                                            |
| POST /publishing/uploads                                 | Multipart file field named file; returns asset_id and its expiry.                                                    |
| GET /publications                                        | Up to 50 recent publications, without credentials or source URLs.                                                    |
| POST /publications                                       | Prepare with UUID client_request_id, kind IMAGE or REELS, asset_id or media_url, caption and optional share_to_feed. |
| POST /publications/:publication/status                   | Check processing or uncertain publication status.                                                                    |
| POST /publications/:publication/publish                  | Publish a ready container after the owner's explicit action.                                                         |

Preparing the same request ID and content returns the existing draft. Reusing it for changed content is rejected. Publishing reserves the operation before calling Meta, so concurrent clicks and request retries do not send it twice. A timeout is marked unconfirmed and cannot be republished automatically: check status and Instagram before creating another draft. Instagram may confirm publication through the container without returning a media ID; in this case use Instagram or import posts to retrieve the permalink. Use **New draft** to intentionally prepare another post.

### App Review: instagram_business_content_publish

Our application lets a business owner create and publish content to their connected Instagram professional account from an authenticated dashboard. The owner authorizes the account through Instagram Login, selects a JPEG photo or MP4 Reel, uploads the file or provides its media URL, writes a caption and prepares the post. The application creates an Instagram media container and checks its processing status. The owner then explicitly clicks Publish to Instagram; the application publishes the ready container and displays a link to the resulting Instagram post. For Reels, the owner can choose whether to share the Reel to the feed. This permission is necessary to create media containers and publish the owner's selected content; without it the publishing feature cannot function. It helps businesses publish their own content from the same workspace where they manage Instagram customer messages and comments. The application publishes only to the account the owner has authorized and does not publish without the owner's explicit action.

For the review recording, show Instagram consent including the publishing permission, select the professional account, upload a real JPEG, enter a caption, prepare and publish it, then open the resulting post on Instagram. A controlled local test is not a real Meta permission test call. Request the direct Instagram permission for this flow, rather than the Facebook Login permission instagram_content_publish.

Reference: [Meta's Instagram Login and publishing API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).
