# Default chatbot flows

## Ready-made industry templates

The authenticated `/v1/admin/chatbot/templates` API provides a shared library of editable starter flows. These are platform starters, not Meta-approved outbound message templates. A library preview does not create a chatbot or use a plan slot. Clicking **Use template** creates one private draft under the authenticated account owner, with copied nodes/edges and fresh UUIDs. It consumes the normal `Chatbot` allowance, including add-on capacity. Editing a copy never changes the shared template or another user's chatbot.

| Category | Template ID | Included branches |
| --- | --- | --- |
| Real estate | `real-estate-starter` | Buy, rent, site-visit request, team enquiry |
| Health care | `health-care-starter` | Appointment request, clinic hours/location, services/fees, team enquiry |
| E-commerce | `e-commerce-starter` | Product enquiry, order enquiry, return/exchange, team enquiry |
| Travel | `travel-starter` | Holiday enquiry, transport enquiry, existing booking, team enquiry |
| Digital marketing | `digital-marketing-starter` | Advertising, SEO/website, social media, team enquiry |
| Hotels and resorts | `hotels-resorts-starter` | Room enquiry, event enquiry, existing reservation, team enquiry |
| Education | `education-starter` | Courses, fees/admissions, counselling request, team enquiry |
| IT companies and SaaS | `it-saas-starter` | Demo request, project brief, technical support, team enquiry |
| MLM and affiliates | `mlm-affiliates-starter` | Programme information, application enquiry, existing partner help, team enquiry |

Send `Authorization: Bearer <token>` on every request. Read the categories and gallery:

```http
GET /v1/admin/chatbot/templates/categories
GET /v1/admin/chatbot/templates
GET /v1/admin/chatbot/templates?category=real-estate
GET /v1/admin/chatbot/templates/real-estate-starter
```

Categories return `{id, name, template_count}` rows. The gallery returns metadata, `use_cases`, `customization_fields`, `setup_notes`, `version`, `approval_status: "platform_starter"` and `meta_approved: false`, without loading all graphs. A detail response adds `nodes` and `edges` suitable for the existing builder. Category filters use the category slug, not the template ID. An unknown category returns HTTP 400; an unknown template returns 404.

Create an editable copy:

```http
POST /v1/admin/chatbot/templates/real-estate-starter/use
Content-Type: application/json
```

```json
{
  "name": "My Property Assistant",
  "customizations": {
    "business_name": "Example Properties",
    "support_contact": "our sales team in this WhatsApp chat"
  }
}
```

`business_name` is required (1–100 characters). `support_contact` is optional (1–120 characters); the default is “our team in this WhatsApp chat”. `name` is optional (1–100 characters), defaulting to the template name. Fields are plain text without `{{...}}` placeholders. No request company/user IDs, graph overrides or published state are accepted. Ownership comes from authenticated membership, and the server verifies the owner belongs to that company.

HTTP 201 returns the created chatbot in `data`, including its `id`, `user_id`, `company_id`, `status: "draft"`, `published: false`, copied `nodes` and `edges`, `template_id`, `template_version`, `phoneNumberIds: []` and `requires_phone_assignment: true`. The copy is saved to the existing `chat_bot`, `chat_bot_node` and `chat_bot_edge` tables. No schema migration is required. Creating the bot, graph, activity audit and quota update is one transaction; failures leave no partial draft. Use-template requests intentionally create new copies, so disable the button while a request is pending and refetch the chatbot list before retrying an ambiguous timeout.

For the frontend:

1. Add **Start from template** beside the existing blank chatbot action. Show category cards and **Preview** / **Use template** actions.
2. Preview a template's detail graph without saving it. Collect the business name, optional support contact and chatbot name before creating a copy.
3. After HTTP 201, open the existing builder using `data.id`. Populate its nodes/edges from that response or `GET /v1/admin/chatbot/<chatBotId>`.
4. Let the owner edit the menu, text, questions, trigger keywords, nodes and edges normally. Choose an owned receiving phone number.
5. Save with the **existing** `POST /v1/admin/chatbot/flow/<chatBotId>` endpoint. Submit `name`, the complete edited `nodes`/`edges`, and `phoneNumberIds: ["<owned Meta phone ID or local phone UUID>"]`.
6. Publish explicitly through the **existing** `PUT /v1/admin/chatbot/<chatBotId>/publish`. The normal phone/keyword/default-flow conflict checks still apply. A clone without a saved phone mapping cannot be published.

Do not stringify `data` or positions inside the editor's nodes; the server serializes them for PostgreSQL. Keep list option IDs matched to each edge's `sourceHandle` (also preserved in edge `data.sourceHandle`). Templates use the current `trigger` / `message` node types and `@whatsapp/on-message`, `@whatsapp/send-list-message`, `@whatsapp/ask-question`, `@whatsapp/send-text-message` keys. The ordinary runtime collects question answers in chat session variables and follows the connected branch. No special template runtime is introduced. Default behavior can be selected by editing the trigger keywords to `[]`, following the rules below.

These starters collect enquiries; bookings, payments, order lookups, CRM writes, automatic notifications, live agent assignment and ticket creation are not preconfigured. Add the relevant integration/action nodes to the private copy before promising these actions to customers. In particular, appointment/booking confirmations, current prices and partner earnings are not invented by the templates. No bot is automatically published or attached to a phone when browsing or copying the library.

Import `postman/chatbot-templates.postman_collection.json` for the gallery, copy, read, edit/save and publish requests.

## Default routing

Save a flow using the existing create-flow endpoint with `nodes[].type: "trigger"` and `data.attributes.keywords: []` on that trigger. Omitting keywords or supplying only whitespace also selects default behavior. Keep the trigger connected to a message/action node and supply the receiving `phoneNumberIds` as usual. Publish the saved chatbot to activate it.

The save response includes `isDefault: true` and `triggerWords: []`. The saved trigger attributes also include `isDefault: true`. Keywords are authoritative: adding nonempty keywords converts the flow back to keyword matching.

Only one default flow may be assigned to each number, including draft reservations. Saving another returns `CHATBOT_DEFAULT_CONFLICT`. Edit the existing default, remove that number from it, or delete it before assigning a replacement. Unpublishing disables execution but retains its reservation, as with keyword flows.

Incoming routing priority is an exact normalized keyword match, then an active conversation, then the published default for any nonempty text. Replies in an active conversation continue its flow. Media, blank text, and interactive replies do not start a default flow on their own. Default starts bypass the legacy FPO phone-number registration interpretation so numeric messages can start the configured flow normally.

Connected button/list replies take priority over keyword matching, including names such as Services or Social Media that also appear in trigger keywords. Typed option titles continue the current menu too. Recognized reply IDs from earlier messages can follow their original connections within the same active chatbot; labels alone never select a branch on another node. Unknown IDs, missing targets and ambiguous reused IDs cannot jump to an arbitrary branch. The resolver indexes nodes and connections once per loaded graph and reuses the same selected session when executing the branch. Saving preserves top-level `sourceHandle` values inside persisted edge data.

The default phone assignment is stored in `chatbot_triggers` with an empty `trigger_word`. Existing active/published handling applies; no new column is required. Runtime default lookup is explicit and does not participate in keyword lookup.

This repository contains the backend. A separate flow-editor frontend must permit an empty keyword list when submitting the flow.

When a default flow is waiting at a button or list menu, unmatched text sends that menu again. Valid selections still follow their branches, question nodes still collect answers, and delayed flows remain paused. Saving a flow closes its active sessions because the saved graph receives new node IDs; the next text can start the updated default. Existing default sessions pointing to missing nodes also recover on the next text.
