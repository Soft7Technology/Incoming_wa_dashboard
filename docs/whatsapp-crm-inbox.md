# WhatsApp CRM inbox: frontend integration

## Read and unread

Inbox state means whether a CRM user has viewed **incoming customer messages**. It is shared across the account/team, not a separate read state for each agent.

- `read_status=all`: contacts with at least one non-deleted incoming message, read or unread together, newest message first.
- `read_status=unread`: contacts with at least one incoming message whose `inbox_read_at` is null.
- `read_status=read`: contacts with incoming history and no unviewed incoming messages.
- Sending a campaign to 200 recipients creates no unread conversations. If five recipients reply, those five become unread until viewed in the CRM.
- Campaign-only contacts remain available in the contact directory: omit `read_status` to include them.

Use the contact response's `read_status` and `unread_count` for tabs, badges and highlighting. `read_count` counts viewed incoming messages. Ignore deleted incoming messages for these counts. Do not infer inbox state from `last_message.status`, `last_message.read_at`, or the latest message's direction. An outgoing message can be the preview while an older incoming message is still unread.

Keep outbound `status` and `read_at` for WhatsApp delivery ticks and campaign analytics. A customer's read receipt must never clear the CRM unread badge. Existing incoming rows without `inbox_read_at` count as unread, even when their provider status says `read`.

## Lists and displayed time

```http
GET /v1/admin/contacts/{internalPhoneNumberId}?page=1&limit=10&read_status=all&sortBy=last_message_at&sortOrder=desc
```

Replace `all` with `read` or `unread` for the other tabs. The legacy `sortBy=created_at` also uses message time when `read_status` is supplied. Filtering and ordering happen before pagination. All does not prioritize unread chats. Explicit alternative sorts such as `name` remain supported.

Display `last_message.timestamp` or `last_message_at`; both come from the latest message's `created_at`. Delivery receipts and marking messages read do not move a conversation. Equal timestamps use contact ID for stable ordering. On incoming messages, reset/refetch affected pages rather than sorting just the currently loaded page.

## Mark messages viewed

After the conversation is open, the document is visible, and incoming messages have rendered, send the last incoming message that the user has actually viewed:

```http
POST /v1/admin/messages/mark-read
Content-Type: application/json

{
  "phone_number_id": "<internal business phone UUID>",
  "message_id": "<last viewed incoming message UUID or wamid>"
}
```

This marks only incoming messages in the same account, business number and customer conversation, through that message. Later arrivals remain unread. Repeated calls are safe. The API accepts `contact_id` instead of `message_id`, but that selects the latest message at request time; prefer the rendered message ID to avoid marking unseen arrivals.

Do not call this endpoint when receiving a toast, prefetching a chat, or clicking a notification before its messages load. If an incoming message is visible in the already-open chat, acknowledge it after rendering. After success, refresh the contact, active list and unread badge. A failed provider read receipt does not undo the saved CRM view; the response includes `read_receipt_sent` separately. A failed API request must leave the UI unread until it succeeds.

## Clickable incoming-message toasts

The socket event remains `new_message` and includes:

```json
{
  "id": "<database message UUID>",
  "wamid": "<WhatsApp message ID>",
  "contactId": "<contact UUID>",
  "phoneNumberId": "<internal business phone UUID>",
  "metaPhoneNumberId": "<Meta phone number ID>",
  "companyId": "<company UUID>",
  "userId": "<account owner UUID>",
  "contactPhone": "<customer international digits>",
  "direction": "incoming",
  "inboxRead": false,
  "createdAt": "<persisted message creation time>"
}
```

Use `phoneNumberId` for the CRM sender selector and API URLs. `metaPhoneNumberId` is the provider ID; do not confuse the two. Use `${phoneNumberId}:${id}` as the toast deduplication key.

On toast click:

1. Open the inbox and select the event's `phoneNumberId`. Carry `contactId` and `id` in the app's route or navigation state. Verify the event belongs to the current authenticated account.
2. Select All and clear filters that would hide the target. Reset pagination. Cancel or ignore pending requests for the previous conversation so they cannot overwrite the new selection.
3. Resolve the contact using `GET /v1/admin/contacts/by-id/{contactId}` if necessary. A notification target need not be on the currently loaded contacts page.
4. Fetch `GET /v1/admin/messages/lead/conversations?phone_number_id={phoneNumberId}&leadNumber={contactPhone}` with the normal authenticated API client. URL-encode query values. Open that contact, then scroll to and highlight the row whose `id` matches the event, with `wamid` as a fallback. If history is paginated by the UI, load the target before scrolling.
5. After the target is rendered and visible, call mark-read with the last incoming message actually viewed, then refresh counts/list state. Keep later unviewed messages unread. Handle missing or unauthorized targets without selecting another conversation.

The frontend should retain the notification target while sender/history loading completes. Do not locate a chat using the customer number alone: one customer can message multiple business numbers. These frontend navigation and toast handlers must be implemented in the dashboard repository; this API repository supplies the fields and endpoints.
