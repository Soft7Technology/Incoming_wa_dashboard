# Simple campaign opt-in/out

Apply `20260928000002_contact_campaign_opt_out.ts` before deploying the API and workers. No database migration was run during implementation.

`contacts.is_opted_out` defaults to false. True excludes a number from campaigns; false means this feature does not suppress it, not that consent evidence was collected. Imports and ordinary inbound messages do not explicitly grant consent. Existing records remain eligible by default.

Configure each business number with an authenticated account-owner request:

```http
PUT /v1/admin/contacts/opt-in-out/keywords/<phone-number-id>
Authorization: Bearer <JWT>
Content-Type: application/json
```

```json
{"opt_in_keywords":["START","SUBSCRIBE"],"opt_out_keywords":["STOP","UNSUBSCRIBE"]}
```

GET the same URL to read settings. The phone identifier may be the local UUID or Meta ID. Defaults are START and STOP/UNSUBSCRIBE. Matching is case-insensitive, trims/collapses whitespace and requires the whole message; interactive reply IDs are also supported. Both arrays are required on PUT, each limited to 30 entries of 80 characters, with no overlap. Empty arrays disable that keyword group.

Manually change a contact with:

```http
PUT /v1/admin/contacts/<contact-id>/opt-in-out
Authorization: Bearer <JWT>
Content-Type: application/json
```

```json
{"is_opted_out":true}
```

Use false to opt back in. Existing company, owner and member-assignment access rules apply. Contact responses include the flag where full contact rows are returned.

Incoming keyword matches save the message, update the flag for the same account, business number and full country/phone identity, and skip the chatbot for that turn. No confirmation messages or audit tables are added. Another sending number or company is unaffected. Duplicate contact identities are kept consistent; opted-out historical/deleted records also prevent re-creating the same identity to bypass suppression, and a later START clears that identity's suppression.

Campaign creation excludes blocked numbers before inserting campaign_messages. A previously queued campaign rechecks before its send and marks the recipient skipped with CONTACT_OPTED_OUT, without sending to Meta or charging credits. Already in-flight messages cannot be recalled. Direct/support messages are unchanged. Opting back in does not automatically re-add previously excluded or skipped campaign recipients.

## Maintenance and rollout

The controller only handles HTTP input/output; the service validates payloads and enforces company/owner scope, including member assignment checks for contact updates. Keyword reads always return arrays, and malformed legacy keyword JSON is treated as an empty list instead of interrupting inbound message processing. Keyword length is checked before and after Unicode normalization.

Apply the additional `20260928000003_index_contact_opt_out.ts` migration for the partial campaign-suppression lookup index. It includes opted-out historical/deleted identities. Neither migration was run as part of this refactor. API paths, bodies and campaign-only behavior are unchanged.
