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

`field` reads a contact value; `value` supplies literal text. `fallbackValue` is optional and may be omitted or set to `null` when creating a campaign. A missing or null field uses a supplied string `fallbackValue`; otherwise its variable is saved as JSON `null` and passed as `null` in the outgoing campaign template parameter. Existing values, including empty strings, zero and false, are preserved as text. For example, `{ "field": "contact.name" }` uses the contact's name when present and `null` when the name is null or missing. Adding `"fallbackValue": "Guest"` uses `Guest` instead for null or missing names. Prefixes `contact.`, `custom_fields.` and `attributes.` select the source explicitly. Nested paths are supported, including `contact.custom_fields.check` and `contact.attributes.address.city`. Exact keys take precedence over nested paths, preserving custom field names containing spaces or dots.

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
