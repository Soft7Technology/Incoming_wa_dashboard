# Template management

Dashboard base: `/v1/admin/templates` with login JWT. Integration base: `/v1/api/templates` with user API key. All operations check WABA account ownership.

## Create

POST `/create`:

```json
{
  "waba_id": "YOUR_WABA_ID",
  "name": "order_update",
  "language": "en_US",
  "category": "UTILITY",
  "parameter_format": "POSITIONAL",
  "components": [{
    "type": "BODY",
    "text": "Hello {{1}}, your order {{2}} has shipped.",
    "example": {"body_text": [["Ramesh", "ORDER-1402"]]}
  }]
}
```

Create each translation through a separate request with the same name and WABA, a different language (such as `hi` or `mr`), and translated components. There is no automatic translation or atomic batch. Each variant has its own local UUID, Meta ID and approval status. Retry only failed variants. Filter the list using `GET /?wabaId=...&language=hi`.

## Update

PATCH `/:id` using the local template UUID:

```json
{
  "components": [{
    "type": "BODY",
    "text": "Hello {{1}}, order {{2}} is on its way.",
    "example": {"body_text": [["Ramesh", "ORDER-1402"]]}
  }]
}
```

Provide the complete components array, including any header, footer and buttons to retain. Updates accept category, components and message_send_ttl_seconds; name, language and WABA cannot be changed. Create a new variant for another language. Current Meta status is fetched before editing. Local guards allow APPROVED, REJECTED and PAUSED and reject category changes for approved templates. Meta enforces edit quotas, supported languages, category-specific TTLs and specialized component/policy rules.

After a successful edit, local state becomes PENDING before refreshing from Meta. If refresh fails, sync before retrying: the edit may already have succeeded. Likewise, sync if creation succeeded remotely but local persistence failed.

Media header samples require `example.header_handle` from Meta resumable upload, not a public image URL. Text variables require examples. Named variables use named examples with `parameter_format: "NAMED"` on creation. Advanced/authentication component fields are preserved and validated by Meta.

Deletion targets a specific Meta template ID, preserving other language variants. Local deletion follows successful Meta deletion. Sync traverses all pages and matches each WABA/name/language separately.

## Deployment

Apply `20260930000004_template_waba_identity.ts` before deploying matching API and worker code. Active template uniqueness becomes company/WABA/name/language. No live migration or Meta mutation was performed. Tests mock Meta, so live approval and edit policy outcomes are not verified.

References: [Meta template collection](https://www.postman.com/meta/whatsapp-business-platform/folder/lczy75a/templates), [Meta management examples](https://www.postman.com/meta/whatsapp-business-platform/documentation/3kru5r6/moved-whatsapp-business-management-api). The direct Meta developer documentation returned HTTP 429 during review; specialized policies remain subject to Meta validation and the configured Graph API version.
