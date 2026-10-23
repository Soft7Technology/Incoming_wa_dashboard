# Facebook Page posts and user content

Open `/v1/facebook/posts` directly and click **Connect Facebook Page**; no application login is required. Each visitor receives a separate browser workspace. See [Public Meta workspaces](public-meta-workspaces.md) for the required migration and public API paths. This workspace implements `pages_read_user_content` and `pages_manage_posts`, alongside `pages_show_list` and `pages_read_engagement` for Page selection and metadata. Messenger, Lead Forms and Instagram retain their separate connections.

## Connect a Page

1. In Meta app **1456789056182846**, create or select a Facebook Login for Business configuration that issues a **USER token**, selects managed Page assets and includes all four permissions above. Put that configuration's ID in `FACEBOOK_PAGES_LOGIN_CONFIG_ID`. The parent Facebook app credentials, Graph version, public origin and encryption key use the existing `FACEBOOK_*` settings.
2. Set `FACEBOOK_PAGES_LOGIN_MODE=business` (the default). Use `classic` only if this app is configured to support classic Facebook Login; that mode requests the four scopes explicitly.
3. Add the exact `https://YOUR-PUBLIC-HOST/v1/facebook/posts/oauth/callback` to Facebook Login's **Valid OAuth Redirect URIs**. Keep the public host reachable during review. Restart after environment changes.
4. Click **Connect Facebook Page**, complete Facebook authorization, select an authorized Page and click **Connect selected Page**. The selected account needs the relevant Page access/task to publish content; Meta checks this when the API is called. The app validates both user and Page token grants and binds the connection to the configured app.
5. Alternatively open **Connect using a Facebook user access token**. Enter a fresh USER token generated for this app with all four permissions. The app validates the token's app, validity, type and grants, lists its authorized Pages, and retains only encrypted Page credentials for selection. This route does not require a Login configuration ID. Do not use a System User token or a token generated for Graph API Explorer's own app.

Apply migration `20261015000004_create_facebook_content.ts` (or the compiled JavaScript equivalent) before running this feature. It creates separate Page connections, temporary OAuth selections, imported feed posts/comments and publishing action records. Build with `npm run build`; assets are included by the existing Facebook asset build step.

## Read user content: pages_read_user_content

1. Open the connected Page and click **Refresh feed**. This calls `GET /{page-id}/feed` with its scoped Page token and imports post text, available author information, timestamps and Facebook permalinks.
2. Choose **Visitor posts** to view feed posts Facebook identifies as authored by someone other than the Page. New Page experiences and Page settings may limit visitor posts; an empty visitor filter alone does not demonstrate a failure.
3. Click **Read comments** on a post, then **Refresh comments**, to retrieve `GET /{post-id}/comments` and display customer comments and available author names. This is a reliable way to demonstrate user content on a Page that has no visitor posts available.
4. Use **Import more posts/comments** for cursor pagination. The UI shows up to 100 recent locally stored posts or comments per list. It does not reply to, hide, edit or delete comments; those actions are outside this feature.

## Publish, edit and delete: pages_manage_posts

1. Under **Create a Page post**, enter text and an optional HTTPS link. The UI identifies the selected Page under **Publishing as**.
2. Click **Publish to Facebook** to call `POST /{page-id}/feed`. Publishing is immediate and follows the owner's explicit action. A successful result stores the actual Facebook post ID. The app refreshes the feed to retrieve a permalink when available.
3. On an app-created post, use **Edit post**, change its text and click **Save changes**. The server calls `POST /{post-id}` with the updated message. Link changes are not supported.
4. **Delete post** asks the owner to confirm removal from Facebook, then calls `DELETE /{post-id}`. The app marks the locally stored post deleted only after Meta confirms the deletion. This app limits edit/delete to posts it created; visitor posts and posts created elsewhere have no edit/delete controls.

Only text and link publishing is implemented. Photo/video uploads, scheduling and comment moderation are not included. A stable client request ID reserves each publishing action before the Meta call; retrying the same action ID cannot submit it twice. Timeouts and unexpected outcomes are marked **unconfirmed**, and the owner must check the actual Page before repeating an action. A pending request left by a process interruption is also never automatically sent again. Request histories show the latest 30 actions. A local action record confirms what the app received, not Meta's separate App Review testing counter.

## Reviewer login and recording

Use the existing application test account selected for the Instagram submission and the normal login form at `/v1/facebook/posts`. Supply that application's email/password privately in Meta's reviewer instructions. The existing public Messenger review token is intentionally restricted to Messenger and cannot connect Pages in this workspace. Reviewers then authorize their own Facebook account and managed Page through Facebook; do not give them Facebook passwords or access tokens in the written review instructions.

For **pages_read_user_content**, record application login, Facebook consent and Page selection. From a different Facebook account, leave a real comment on a post on the connected Page. Show that comment on Facebook, then use **Refresh feed → Read comments → Refresh comments** to display the same text in this application. If visitor posts are enabled and returned for the Page, also show the visitor-post filter. Do not rely on an empty feed or a Page-authored post alone as evidence of reading customer content.

For **pages_manage_posts**, show the selected Page, enter a real text update, click **Publish to Facebook**, and open the actual resulting post on Facebook. Then edit its text in the app and show the update on Facebook. Delete only a post you intend to remove and show the confirmed deletion. Backend tests use controlled Meta responses and do not count as real permission-testing calls. The screencast must show the real app/API result.

### Description: pages_read_user_content

Our application lets a business owner read content shared by customers on their authorized Facebook Page. After Facebook authorization and Page selection, the owner refreshes the Page feed and opens a post's comments. We retrieve and display post and comment text, available author information and timestamps, with links to the corresponding Facebook posts. Where Facebook makes visitor posts available, the owner can filter the feed to view posts authored by visitors. This helps businesses understand customer questions and feedback from the same dashboard they use to manage Page updates. The permission is necessary to retrieve user-generated content on the connected Page, including customer comments and available visitor posts. Access is limited to the Page selected and authorized by its owner. This feature reads user content and does not reply to or moderate comments.

### Description: pages_manage_posts

Our application allows a business owner to create and manage organic text and link posts on their authorized Facebook Page. After connecting a Page through Facebook Login, the owner writes an update, optionally adds an HTTPS link and explicitly clicks Publish to Facebook. Our backend publishes the content as the selected Page and stores the Facebook post ID. The owner can then edit the text of that app-created post or choose Delete post and confirm its removal. The application displays publishing results and a Facebook permalink when available so the owner can verify the result. This helps businesses publish announcements and maintain their Page content from one authenticated workspace. This permission is necessary to create, update and delete Page posts through the Graph API. Posts are published or changed only following the owner's explicit action, and edit/delete is limited to posts created through this app.

## API and data handling

Protected endpoints live under `/v1/admin/facebook-content` and require the existing application JWT and company owner scope:

| Route                                     | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| GET /setup                                | OAuth availability, token import availability and required permissions. |
| POST /oauth/start                         | Start browser-bound Facebook authorization.                             |
| POST /oauth/token                         | Validate a user token and prepare encrypted Page selection.             |
| GET /oauth/pages                          | Return only authorized Page IDs and names for this browser/owner.       |
| GET or POST /pages                        | List connections or connect a selected Page.                            |
| GET /pages/:id/posts                      | Read locally imported feed posts.                                       |
| POST /pages/:id/posts/sync                | Import a Meta feed page; optional after cursor.                         |
| GET /pages/:id/posts/:post/comments       | Read imported comments on that Page's post.                             |
| POST /pages/:id/posts/:post/comments/sync | Import a Meta comment page; optional after cursor.                      |
| POST /pages/:id/posts                     | Publish with message, optional link and UUID client_request_id.         |
| PATCH or DELETE /pages/:id/posts/:post    | Edit or delete an app-created post with UUID client_request_id.         |
| GET /pages/:id/actions                    | Inspect recent publishing results.                                      |
| POST /pages/:id/disconnect                | Clear this feature's Page credentials, retaining history.               |
| DELETE /pages/:id                         | Delete this local integration and its imported content and history.     |

Page tokens and OAuth candidates use the existing authenticated encryption key. No Meta token is returned to the browser. The owner selects a Page from real API results; post/comment lookups are scoped to that Page, and content is rendered as text. External pagination URLs are ignored; only validated cursors are passed to the fixed Graph host. Page rows serialize publishing and disconnect/deletion operations. Signed Facebook deauthorization clears Page posts credentials; signed Facebook data deletion removes these connections and their local content/action records, including when the application owner is suspended. Removing the local integration does not delete posts already published on Facebook. Public Facebook post deletion is a separate explicit action.

References: [Meta Pages API posts guide](https://developers.facebook.com/docs/pages-api/posts/), [Meta's official Page SDK endpoints](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py), and [Meta's official Post SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/post.py).
