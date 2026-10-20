# Campaign parameter mapping

## Direct recipients and drafts

Campaign create and recipient preview no longer impose a 150-entry limit on `contact_filters.contactNumber`. Every entry must still be a phone number string or exact positive integer. Non-empty array validation, contact-list ownership checks, opt-outs, subscription limits, and HTTP request-body limits still apply.

For large audiences, submit existing contact-list IDs in `contact_filters.list_ids` instead of sending all phone numbers. Use the Excel contact-import flow (`POST /v1/admin/contacts/import`) to create a list first if needed. The campaign JSON endpoint does not accept an Excel attachment directly.

Create with `send_immediately: false` and omit `scheduled_at` to save a draft. The existing create request loads matching contacts and saves pending `campaign_messages` before returning; it does not send messages. Start the saved draft using `POST /v1/admin/campaigns/:id/start`. Sending is handled by the existing background worker. Removing the recipient-count cap does not make preparation asynchronous or guarantee arbitrary audience sizes fit server resources.

Direct-number preparation deduplicates identical submitted entries, looks up scoped contact candidates with grouped array predicates, and parses each saved contact once into a reusable phone index. It reuses those candidates instead of issuing a second existing-contact query. National numbers, country hints, ambiguous local matches, opt-outs, and existing targeting filters retain their validation rules. Missing contacts are inserted in batches of 200 inside the existing contact-quota transaction; recipient rows also retain their existing batched insertion. These changes preserve the HTTP response and scheduling behavior and require no migration or frontend payload change.

Regression checks: `node --test tests/campaign-phone.test.cjs tests/campaign-create.test.cjs tests/campaign-contacts.test.cjs tests/campaign-direct-number-limit.test.cjs tests/campaign-recipients.test.cjs`. Set `CAMPAIGN_PHONE_DATABASE_TEST=true` to include the PostgreSQL lookup comparison and 3,000-contact fixture; it runs in an isolated schema and rolls back all fixture data.

`send_immediately: true` still automatically queues sending, and a future `scheduled_at` still creates a scheduled campaign. `save_contacts` is not consumed by this endpoint.

```json
{
  "name": "Imported list campaign",
  "template_id": "23860277-69cd-44c2-b557-08f00ecaf2cf",
  "phone_number_id": "661886587013056",
  "contact_filters": { "list_ids": ["IMPORTED_LIST_UUID"] },
  "parameter_mapping": { "1": "fullName" },
  "send_immediately": false
}
```

## Contact lists for a sending phone

`GET /v1/admin/contacts/phone-number/661886587013056/lists`

Use `Authorization: Bearer <token>`. The equivalent API-key route is `GET /v1/api/contacts/phone-number/:phoneNumberId/lists`. The path accepts either the Meta phone number ID or the local sender UUID. No request body is required.

The response uses the existing list shape: `{ success: true, message: "Lists retrieved successfully", data: [...] }`, with the standard `meta.timestamp`. Each entry includes its `id`, `name`, `phone_number_id`, contact counts, file headers, and existing import-summary fields. Pass the selected entries' `id` values in `contact_filters.list_ids`. Only non-deleted lists for the authenticated account owner, company, and selected sending number are returned; no lists produces `data: []`.

Malformed sender identifiers return HTTP 400; unavailable or foreign senders return HTTP 404. The existing `GET /v1/admin/contacts/lists` continues to return all account lists.

Campaign creation and recipient preview validate `list_ids` as a non-empty array of UUIDs. Every selected list must belong to the account and sending phone. An unavailable, deleted, foreign, or other-phone list returns HTTP 400 with `error.code: "CAMPAIGN_CONTACT_LIST_NOT_AVAILABLE"`, `error.field: "contact_filters.list_ids"`, and `error.required_action: "SELECT_CONTACT_LIST"`, before contact creation or campaign quota consumption.

## Mapping payload

Send `parameter_mapping` in the existing campaign creation payload. Keys match template placeholders (`1` for `{{1}}`, etc.). The frontend can build these entries dynamically from contact columns and custom field keys; no backend field registration or migration is needed.

```json
{
  "parameter_mapping": {
    "1": { "field": "contact.name" },
    "2": { "field": "contact.phone_number" },
    "3": { "field": "custom_fields.Company name", "fallbackValue": "your company" },
    "4": { "field": "custom_fields.tier", "fallbackValue": "standard" },
    "5": { "value": "Thank you" }
  }
}
```

`field` reads a contact value; `value` supplies literal text. `fallbackValue` is optional and may be omitted or set to `null` when creating a campaign. A missing or null field uses a supplied string `fallbackValue`; otherwise its variable is saved as JSON `null` and passed as `null` in the outgoing campaign template parameter. Existing values, including empty strings, zero and false, are preserved as text. For example, `{ "field": "contact.name" }` uses the contact's name when present and `null` when the name is null or missing. Adding `"fallbackValue": "Guest"` uses `Guest` instead for null or missing names. Nested paths are supported, including `contact.custom_fields.check` and `contact.attributes.address.city`. Exact keys take precedence over nested paths, preserving custom field names containing spaces or dots.

For `custom_fields.check` or `contact.custom_fields.check`, lookup checks that recipient's `custom_fields` first, then the same key in `attributes` if the value is missing or null. For `attributes.check` or `contact.attributes.check`, the order is reversed. When both columns contain a value, the requested column wins. `fallbackValue` is used only when neither column supplies a non-null value. For example, the same mapping can use `Hello` from one contact's `custom_fields.check` and `Welcome` from another contact's `attributes.check`.

For a contact with `custom_fields: { "check": "Hello" }`, this mapping supplies `Hello` for both body parameters:

```json
{
  "parameter_mapping": {
    "1": { "field": "contact.custom_fields.check" },
    "2": { "field": "contact.custom_fields.check" }
  }
}
```

Use any stored contact column or custom field key; no names are hardcoded. A field must exist on that recipient to provide a value. Supply a nonempty `fallbackValue` if a recipient might lack a required WhatsApp text parameter; null or empty parameters can be rejected by Meta.

Existing string entries remain supported: `fullName` maps to `name`, `vb_phoneno` maps to `phone_number`, and other keys look up contact columns, then `custom_fields`, then legacy `attributes`. Unrecognized strings remain literal text for compatibility, so prefer explicit `{ "field": "custom_fields.key" }` for custom fields that may be missing.

Mappings are resolved separately for each recipient when the campaign is created and saved in its message's `template_variables`. Subsequent contact edits do not change those saved values. This extends `parameter_mapping` on the existing snake_case campaign API; the alternate camelCase payload (`templateMapping`, `contactList`, etc.) is not an API alias.

Recipient previews include each contact's `custom_fields` and `attributes` objects so the frontend can discover available keys. Contact creation accepts `custom_fields` as an object or a JSON object string and saves it in that column. Campaign field resolution also supports older rows whose `custom_fields` or `attributes` contain a JSON object string. Malformed referenced field containers produce a validation error identifying the contact before campaign/message creation; they do not silently turn a stored value into a missing parameter.
