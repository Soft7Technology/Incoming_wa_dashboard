# Campaign parameter mapping

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
