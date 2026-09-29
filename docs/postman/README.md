# WhatsApp message collection

Import `whatsapp-messages.postman_collection.json` and `whatsapp-messages.postman_environment.json` into Postman, then select the imported environment.

Set these variables locally:

- `base_url`: your API root, including `/v1`, e.g. `https://api.your-domain.com/v1` (no trailing slash).
- `user_api_key`: the issued user API key. Do not use a dashboard JWT or Meta access token.
- `phone_number_id`: the connected WhatsApp sender belonging to that user.
- `recipient`: the full international recipient number including its country calling code.
- Media requests: the relevant media URL or `media_id`.
- Template requests: `template_name`, `template_language`, and parameters matching the approved template.

All 16 examples send to `POST {{base_url}}/api/messages/send` and inherit Bearer authentication from the collection. No company key is required. Existing `x-api-key` clients remain supported; do not send conflicting credentials in both headers.

The collection contains text, image/video/document/audio/sticker by link or existing media ID, and templates with no parameters, a body parameter, or a media header. It contains no admin, payment, contact, template-management, or file-upload endpoints.

Keep API keys private and clear them before exporting or sharing an environment. The provided files contain placeholders only. Run individual requests against an intended recipient; running the entire collection sends multiple messages. Success means the API accepted the operation, not confirmed delivery.
