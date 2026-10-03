# Campaign parameter mapping

Send `parameter_mapping` in the existing campaign creation payload. Keys match template placeholders (`1` for `{{1}}`, etc.). The frontend can build these entries dynamically from contact columns and custom field keys; no backend field registration or migration is needed.

```json
{
  "parameter_mapping": {
    "1": { "field": "contact.name", "fallbackValue": "Guest" },
    "2": { "field": "contact.phone_number" },
    "3": { "field": "custom_fields.Company name", "fallbackValue": "your company" },
    "4": { "field": "custom_fields.tier", "fallbackValue": "standard" },
    "5": { "value": "Thank you" }
  }
}
```

`field` reads a contact value; `value` supplies literal text. A missing or null field uses `fallbackValue`, or empty text if no fallback is supplied. Existing values, including empty strings, zero and false, are preserved as text. For example, `{ "field": "contact.name", "fallbackValue": "Guest" }` uses the contact's name when present and `Guest` when the name is null or missing. Prefixes `contact.`, `custom_fields.` and `attributes.` select the source explicitly. The remainder is the exact key, including spaces or dots.

Existing string entries remain supported: `fullName` maps to `name`, `vb_phoneno` maps to `phone_number`, and other keys look up contact columns, then `custom_fields`, then legacy `attributes`. Unrecognized strings remain literal text for compatibility, so prefer explicit `{ "field": "custom_fields.key" }` for custom fields that may be missing.

Mappings are resolved separately for each recipient when the campaign is created and saved in its message's `template_variables`. Subsequent contact edits do not change those saved values. This extends `parameter_mapping` on the existing snake_case campaign API; the alternate camelCase payload (`templateMapping`, `contactList`, etc.) is not an API alias.
