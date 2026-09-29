# Contact phone storage and rollout

Contacts store `phone_number` as national digits and `country_code` as calling-code digits. For example, Singapore `+6581234567` becomes `81234567` / `65`. Significant national zeros (such as Italian landlines) are preserved. Identity includes company, owner, business phone ID, country code, and national number.

Imports accept a separate calling code or ISO country code, or an explicit `+` / `00` international prefix. Unprefixed numbers without country context are rejected into the existing import error list with the original number retained. Conflicting row country codes are rejected. No country is assumed.

Outbound requests can use an explicit international `to`, national `to` plus `country_code`, or a national number that resolves uniquely to a contact under the sending business number. Campaigns construct the recipient from the saved fields. Meta receives international digits. Webhook sender IDs already contain the international calling code and are parsed as such.

## Required rollout order

1. Back up contacts and run `node scripts/audit-contact-phones.cjs`. Optionally pass a local JSON output path for the full issue report; the console prints only counts and a small sample. This script uses a read-only database transaction and does not import the application's database initializer.
2. Resolve reported ambiguous/invalid numbers with the contact owner and review duplicate identities. Do not fill missing countries with `91`, reinterpret invalid international numbers as Indian local numbers, or automatically merge/delete contacts.
3. Stop API/worker contact writers and apply migration `20260926000001_normalize_contact_phone_identity` with the normal deployment migration process. It locks the table, repeats preflight, normalizes records in batches, removes the country default, and adds digit checks plus country-aware uniqueness. If any record needs clarification, it fails transactionally before data/index changes.
4. Deploy the matching API and workers together. Old workers write a different representation, so mixed versions are unsupported. Restore the backup for a data rollback; automatic down-migration is intentionally refused.

The final read-only audit on 2026-09-26 found 70,626 records and no live phone-identity uniqueness index: 611 numbers without country context, 10,796 invalid international numbers, and 31 duplicate normalized identities. The live dataset changed between audit runs; re-run the audit for current counts. No live data migration was performed during implementation.

## Validation

Focused tests cover India, Singapore, UK, Italy, shared national digits under India/US, exact scoped lookups, import clarification errors, Meta payloads, and migration preflight failure. Run `npx tsc --noEmit` and the contact/import/campaign phone tests before rollout.
