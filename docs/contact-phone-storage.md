# Contact phone storage and import

Contacts store the full number with a leading `+` in `phone_number`. For example, `919372597458` becomes `+919372597458`, with `country_code: "91"`. Incoming-message contacts use the same normalization. Sending uses the existing recipient helper, which avoids adding the calling code twice.

## Optional country information

Excel/CSV imports do not require a country column. The phone library recognizes valid full international numbers with or without `+`. A row country_code or import country_code can resolve a local number; calling codes and ISO country identifiers are supported. There is no default Indian country code.

Numeric contacts whose country cannot be resolved are still saved: `9372597458` becomes `phone_number: "+9372597458"`, `country_code: null`, `is_valid: false`. Adding a leading plus preserves a consistent storage format; it does not establish that the number is internationally valid. These contacts need country information before sending. Malformed characters, unsafe numeric Excel cells, and numbers outside 4?15 digits remain invalid and are not imported.

## Preview API

POST `/v1/admin/contacts/import/preview` using multipart form-data with one `file`. Optional fields: `phone_column`, `name_column`, `email_column`, `country_code`.

The response retains headers, raw preview and total_rows, and includes:

- `valid_count`: numbers recognized by the phone library.
- `needs_country_count`: numeric contacts saved without a resolved country.
- `importable_count`: valid_count + needs_country_count, before duplicate handling.
- `invalid_count`: malformed rows excluded from import.
- `normalized_preview`: up to five importable contacts in their storage format.
- `needs_country`: importable contacts requiring country information.
- `errors`: malformed rows and their reasons.

Actual import uses the same parser. Unresolved contacts are included in import, not in failed counts. Validation does not confirm WhatsApp registration or database uniqueness.

## Deployment

Apply pending migrations through `20260930000003_allow_unresolved_contact_phones.ts` with API and workers stopped, then deploy matching code together. The new migration makes country_code nullable, normalizes existing contacts, and preserves company/owner/business-number uniqueness. Duplicate normalized identities cause the migration to fail before rewriting rows. Earlier pending migrations still run their existing preflight checks and may require data cleanup first.

No database migration was executed during this change. Back up existing data before migration. Automated rollback of the new migration is intentionally blocked because unresolved contacts cannot be converted safely into mandatory split-country storage.

## Campaign recipient override

Campaigns accept numeric recipients without a separate country_code. Unresolved numbers are preserved and attempted without guessing a country. Campaign creation includes these contacts by default; explicitly setting contact_filters.exclude_invalid to true excludes contacts marked is_valid=false. Malformed input remains rejected. Opt-outs and recorded invalid-number failures still prevent sending. This permissive sending behavior is limited to the internal campaign send path; ordinary message API validation is unchanged. Meta may reject an unresolved number, in which case the campaign records the failure.
