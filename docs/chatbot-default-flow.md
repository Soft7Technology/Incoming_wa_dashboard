# Default chatbot flows

Save a flow using the existing create-flow endpoint with `nodes[].type: "trigger"` and `data.attributes.keywords: []` on that trigger. Omitting keywords or supplying only whitespace also selects default behavior. Keep the trigger connected to a message/action node and supply the receiving `phoneNumberIds` as usual. Publish the saved chatbot to activate it.

The save response includes `isDefault: true` and `triggerWords: []`. The saved trigger attributes also include `isDefault: true`. Keywords are authoritative: adding nonempty keywords converts the flow back to keyword matching.

Only one default flow may be assigned to each number, including draft reservations. Saving another returns `CHATBOT_DEFAULT_CONFLICT`. Edit the existing default, remove that number from it, or delete it before assigning a replacement. Unpublishing disables execution but retains its reservation, as with keyword flows.

Incoming routing priority is an exact normalized keyword match, then an active conversation, then the published default for any nonempty text. Replies in an active conversation continue its flow. Media, blank text, and interactive replies do not start a default flow on their own. Default starts bypass the legacy FPO phone-number registration interpretation so numeric messages can start the configured flow normally.

The default phone assignment is stored in `chatbot_triggers` with an empty `trigger_word`. Existing active/published handling applies; no new column is required. Runtime default lookup is explicit and does not participate in keyword lookup.

This repository contains the backend. A separate flow-editor frontend must permit an empty keyword list when submitting the flow.

When a default flow is waiting at a button or list menu, unmatched text sends that menu again. Valid selections still follow their branches, question nodes still collect answers, and delayed flows remain paused. Saving a flow closes its active sessions because the saved graph receives new node IDs; the next text can start the updated default. Existing default sessions pointing to missing nodes also recover on the next text.
