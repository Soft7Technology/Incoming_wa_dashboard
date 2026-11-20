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

## Images from contact columns

Campaigns with an approved `HEADER` component whose `format` is `IMAGE` accept the reserved mapping key `header_image_url`. It selects an image URL separately for each recipient using the same contact field lookup as text variables. No database migration or additional upload is required for a stored URL.

Send this in the existing `POST /v1/admin/campaigns` request (the API-key equivalent is `POST /v1/api/campaigns`):

```json
{
  "name": "Personalized image campaign",
  "phone_number_id": "SENDING_PHONE_NUMBER_ID",
  "template_id": "APPROVED_IMAGE_TEMPLATE_UUID",
  "contact_filters": { "list_ids": ["CONTACT_LIST_UUID"] },
  "parameter_mapping": {
    "1": { "field": "contact.name", "fallbackValue": "Guest" },
    "header_image_url": {
      "field": "contact.attributes.Image URL",
      "fallbackValue": "https://cdn.example.com/default.jpg"
    }
  },
  "send_immediately": false
}
```

For a contact with `attributes: { "Image URL": "https://cdn.example.com/alice.jpg" }`, the outgoing header contains `parameters: [{ "type": "image", "image": { "link": "https://cdn.example.com/alice.jpg" } }]`. Another contact uses its own URL. The numbered body mappings remain independent.

`contact.custom_fields.Image URL` also works, including the existing lookup across both attribute containers. Nested paths, literal dotted keys, and case/whitespace matching follow the text-variable rules above. A fixed mapped image can use `"header_image_url": { "value": "https://cdn.example.com/shared.jpg" }`.

### Frontend controls and preview

1. Show an image source selector only for an `IMAGE` header: **Upload or fixed URL** and **Contact column**.
2. For **Contact column**, reuse the variable field selector and populate it from the recipient preview's contact columns, `attributes`, and `custom_fields`. Store the selected field path in `parameter_mapping.header_image_url.field`; use explicit field objects instead of plain strings. Do not add `{{header_image_url}}` to the template text.
3. Offer an optional **Fallback image URL** input. Send it as `fallbackValue` only when supplied. It applies to missing or null values. Empty strings and invalid nonempty values cause validation errors even when a fallback is configured; show these contacts as needing correction.
4. Display the selected recipient's resolved image and URL in the preview. Use a directly accessible image URL, not a page containing an image or a local file path. Backend validation checks HTTP(S) URL syntax and rejects embedded credentials; it does not download the URL or check image contents or availability.
5. When switching back to **Upload or fixed URL**, remove `header_image_url` from `parameter_mapping` and use the existing `media_uploads`, for example `[{ "type": "image", "url": "https://cdn.example.com/shared.jpg" }]` or `[{ "type": "image", "media_id": "UPLOADED_MEDIA_ID" }]`. Remove the image mapping when switching to a template without an image header.

The mapped image takes precedence over campaign-wide `media_uploads` and the template sample. An invalid mapped image never silently switches to those images. When the reserved mapping key is absent, the existing shared media and template sample behavior remains in place. Within a shared image entry, `media_id` takes precedence over `link` or `url`.

### Validation and saved campaigns

Creation returns HTTP 400 if a mapped recipient image is missing or invalid, before saving the campaign or recipient messages or queueing sends. Error details include `code: "CAMPAIGN_IMAGE_URL_INVALID"`, `field: "parameter_mapping.header_image_url"`, and `contact_id` for the affected recipient. Display the error on the image selector and identify the contact that needs correction. Direct-number requests can still create missing contacts during the existing recipient preparation step before image validation.

Mapping an image on a template without an image header returns HTTP 400 with `code: "CAMPAIGN_IMAGE_HEADER_REQUIRED"` and the same `field`. Existing malformed mapping and attribute-container validation errors also apply.

Resolved image URLs are saved in each message's `template_variables.header_image_url` at campaign creation. Later edits to contact attributes do not change an already-created campaign. Create a new campaign to use updated links. The recipient preview endpoint lists contacts and attributes; it does not validate the image mapping.

### Test sends

`POST /v1/admin/campaigns/:id/test` retains its existing `{ "test_phone_number": "..." }` request. It resolves mappings using the existing mock contact (`name: "Test User"`, the supplied phone number, and empty attributes), not the saved contact matching that phone number. For a contact-column image, configure a valid fallback URL to test sending; otherwise the test returns `CAMPAIGN_IMAGE_URL_INVALID`. A fixed mapped URL or the existing shared media also works. Production sends use each recipient's saved image URL. Both paths use the same image payload builder.

Deploy the updated API and campaign worker together before enabling the frontend selector. Regression checks: `node --test tests/campaign-create.test.cjs tests/contact-custom-fields.test.cjs tests/template-payload.test.cjs`.
