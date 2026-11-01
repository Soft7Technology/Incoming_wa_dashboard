# Chatbot template library: frontend API

The library contains 21 starter templates in 11 categories. Twelve templates were added for the four categories below. They use the existing WhatsApp chatbot engine. They are platform-provided starters (`approval_status: "platform_starter"`, `meta_approved: false`), not Meta-approved outbound message templates. No approval request is sent to Meta.

## New templates

| Category slug | Template ID | Main branches |
| --- | --- | --- |
| `e-commerce` | `ecommerce-order-tracking` | Tracking enquiry, delivery issue |
| `e-commerce` | `ecommerce-return-exchange` | Return request, exchange request |
| `e-commerce` | `ecommerce-bulk-orders` | Bulk purchase, corporate gifting |
| `it-services` | `it-services-support` | Technical issue, callback request |
| `it-services` | `it-services-project-quote` | Website brief, application brief |
| `it-services` | `it-services-cloud-consultation` | Cloud migration, security consultation |
| `real-estate` | `real-estate-buyer-enquiry` | Home search, commercial property enquiry |
| `real-estate` | `real-estate-visit-request` | Site visit, virtual tour request |
| `real-estate` | `real-estate-rental-enquiry` | Tenant preferences, landlord enquiry |
| `finance-banking` | `finance-loan-enquiry` | Loan enquiry, callback request |
| `finance-banking` | `finance-investment-consultation` | Goal discussion, adviser appointment |
| `finance-banking` | `finance-tax-consultation` | Personal tax, business tax enquiry |

Every template also includes a team-enquiry branch. Paths run from a keyword trigger to a menu, question nodes, and a completion message. Each question has a named session variable. These flows collect enquiries; live order lookup, booking confirmation, ticket creation and financial decisions require configured integrations or team action. They contain no invented performance percentages.

## Endpoints

Base path: `/v1/admin/chatbot`. Send the existing `Authorization: Bearer <token>` header. Responses wrap results in `data` with `success` and `message`.

| Method | Path | Frontend use |
| --- | --- | --- |
| GET | `/templates/categories` | Category tabs and template counts |
| GET | `/templates` | All available template cards |
| GET | `/templates?category=e-commerce&search=order` | Filter cards by category and optional name search |
| GET | `/templates/:templateId` | Flow Preview: full `nodes` and `edges` |
| POST | `/templates/:templateId/demo` | Simulate one conversation step without sending messages |
| POST | `/templates/:templateId/use` | Copy into an editable, unpublished chatbot |
| GET | `/` | Existing account chatbot list |
| GET | `/:chatBotId` | Load a saved chatbot |
| POST | `/flow/:chatBotId` | Existing API: save edited nodes/edges and assign phone numbers |
| PUT | `/:chatBotId/publish` | Existing API: publish after phone assignment and validation |
| PUT | `/:chatBotId/unpublish` | Existing API: stop the chatbot |

List responses keep the existing `data: []` shape. The current library returns all matching cards; paginate this small array in the frontend. Card metadata includes `id`, `name`, `description`, `category`, `category_name`, `tags`, `badge`, `highlights`, `use_cases`, `version`, `channel`, `customization_fields`, and `setup_notes`. Only detail includes graphs. Category counts include available templates. Use category IDs returned by the API; `All` means omit the category parameter. Unsupported category or malformed inputs return 400; unavailable/missing templates return 404.

## Use this Template

`POST /templates/it-services-support/use`

```json
{
  "name": "My IT Helpdesk",
  "customizations": {
    "business_name": "Example IT Services",
    "support_contact": "support@example.com"
  }
}
```

`business_name` is required (maximum 100 characters); `support_contact` and `name` are optional (maximum 120 and 100 characters). The server owns company/user identity, graph content and publication state. Do not submit those fields in this body.

HTTP 201 returns `data.id`, `nodes`, `edges`, `template_id`, `template_version`, `status: "draft"`, `published: false`, `phoneNumberIds: []` and `requires_phone_assignment: true`. Open the existing editor using `data.id`. Node and edge UUIDs are fresh for each copy. Library entries remain unchanged. The normal Chatbot plan allowance applies; copying creates one bot and consumes one slot atomically with its graph and audit record. Disable the button while pending; each successful use request creates another copy.

Save through `/flow/:chatBotId` with `{ "name": "...", "nodes": [...], "edges": [...], "phoneNumberIds": ["owned-phone-id"] }`, then publish. Keep edge `sourceHandle` and `data.sourceHandle` matched to the menu option IDs. The API creates WhatsApp graphs, not Messenger-compatible graphs.

## Demo button

Start with `POST /templates/it-services-support/demo` and `{}`. The response contains `node_id: "menu"`, `message`, `choices`, `awaiting_answer`, `completed`, `captured`, `simulated: true`, and `persisted: false`.

Select an option using its returned ID:

```json
{ "node_id": "menu", "choice_id": "choice_incident" }
```

Answer the returned question using the returned node ID:

```json
{ "node_id": "incident_name", "answer": "Demo Customer" }
```

Continue until `completed: true`. The frontend retains the transcript and accumulates `captured` values if needed. The demo is stateless and stores no sessions, creates no bots, consumes no quota and contacts no provider. Use sample information for demos. It simulates this starter library's menus and questions, not arbitrary edited flows or external integrations.

## Database tables

Migration: `20261101000004_chatbot_template_library.ts`. The migration seeds a frozen version of the library, so future source changes cannot silently change historical migrations.

| Table | Fields / purpose |
| --- | --- |
| `chatbot_template_categories` | `id`, `name`, `sort_order`: shared category tabs |
| `chatbot_templates` | `id`, `category_id`, `name`, `version`, `available`, `metadata`, `nodes`, `edges`, timestamps: shared templates; graph fields are JSONB |
| `chatbot_template_installs` | `chatbot_id`, `template_id`, `template_version`, `created_at`: provenance of each copy; removed when its chatbot is deleted |
| `chat_bot` | Existing tenant-owned chatbot draft |
| `chat_bot_node` | Existing copied/editable nodes |
| `chat_bot_edge` | Existing copied/editable connections |

There are no tenant APIs for changing the shared library. The `available` flag controls listing and copying. Library changes should be released through reviewed migrations. Private copies remain editable through the existing chatbot editor.
